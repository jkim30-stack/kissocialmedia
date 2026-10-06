-- KIS Social: profiles, posts, media bucket, and row-level security.

-- Profiles ---------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  avatar_url text,
  role text not null default 'Student'
    check (role in ('Student', 'Parent', 'Alumni', 'Teacher', 'Staff')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Members can read profiles"
  on public.profiles for select to authenticated
  using (true);

create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Create a profile row automatically when someone signs up.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := left(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 60);
  v_role text := coalesce(new.raw_user_meta_data ->> 'role', '');
begin
  if v_name = '' then
    v_name := left(split_part(new.email, '@', 1), 60);
  end if;
  if v_role not in ('Student', 'Parent', 'Alumni', 'Teacher', 'Staff') then
    v_role := 'Student';
  end if;
  insert into public.profiles (id, display_name, role) values (new.id, v_name, v_role);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Posts ------------------------------------------------------------------
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  image_path text not null,
  caption text not null check (char_length(btrim(caption)) between 1 and 500),
  created_at timestamptz not null default now()
);

create index posts_created_at_idx on public.posts (created_at desc, id desc);
create index posts_author_id_idx on public.posts (author_id, created_at desc);

alter table public.posts enable row level security;

create policy "Members can read posts"
  on public.posts for select to authenticated
  using (true);

create policy "Users can create their own posts"
  on public.posts for insert to authenticated
  with check ((select auth.uid()) = author_id);

create policy "Users can delete their own posts"
  on public.posts for delete to authenticated
  using ((select auth.uid()) = author_id);

-- Storage ----------------------------------------------------------------
-- Private bucket. Paths: posts/<user-id>/<file>, avatars/<user-id>/<file>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

create policy "Members can read media"
  on storage.objects for select to authenticated
  using (bucket_id = 'media');

create policy "Users can upload to their own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] in ('posts', 'avatars')
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

create policy "Users can replace files in their own folder"
  on storage.objects for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[2] = (select auth.uid())::text)
  with check (bucket_id = 'media' and (storage.foldername(name))[2] = (select auth.uid())::text);

create policy "Users can delete files in their own folder"
  on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[2] = (select auth.uid())::text);

-- The trigger function is not meant to be called over the API.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
