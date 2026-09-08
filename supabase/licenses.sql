-- Revolution Fiskalizim — tabele licencash (Supabase oqquiuisreztzcyehpiq)
-- Ekzekuto në Supabase SQL Editor

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  emri text NOT NULL,
  email text,
  telefon text,
  adresa text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES public.clients (id) ON DELETE SET NULL,
  license_key text NOT NULL,
  hardware_id text,
  app_type text NOT NULL DEFAULT 'fiskalizim',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'suspended', 'expired')),
  max_terminals integer NOT NULL DEFAULT 1 CHECK (max_terminals >= 1),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT licenses_license_key_unique UNIQUE (license_key)
);

CREATE TABLE IF NOT EXISTS public.terminalet_e_licences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id uuid NOT NULL REFERENCES public.licenses (id) ON DELETE CASCADE,
  device_id text NOT NULL,
  last_seen timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT terminalet_e_licences_license_device_unique UNIQUE (license_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_licenses_license_key ON public.licenses (license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_client_id ON public.licenses (client_id);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON public.licenses (status);
CREATE INDEX IF NOT EXISTS idx_licenses_app_type ON public.licenses (app_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_hardware_id_unique
ON public.licenses (upper(regexp_replace(hardware_id, '[^A-Za-z0-9]', '', 'g')))
WHERE hardware_id IS NOT NULL
  AND length(regexp_replace(hardware_id, '[^A-Za-z0-9]', '', 'g')) >= 16;
CREATE INDEX IF NOT EXISTS idx_terminalet_license_id ON public.terminalet_e_licences (license_id);
CREATE INDEX IF NOT EXISTS idx_terminalet_device_id ON public.terminalet_e_licences (device_id);

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.terminalet_e_licences ENABLE ROW LEVEL SECURITY;

-- Pa policy publike: vetëm service_role (serveri Fiskalizim) ka akses të plotë.

NOTIFY pgrst, 'reload schema';
