CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES public.clients (id) ON DELETE CASCADE,
  emri text,
  email text NOT NULL,
  roli text NOT NULL DEFAULT 'client_admin',
  aktiv boolean NOT NULL DEFAULT true,
  passwordi text,
  password_set_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS idx_users_client_id ON public.users (client_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users (email);
CREATE INDEX IF NOT EXISTS idx_users_roli ON public.users (roli);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
