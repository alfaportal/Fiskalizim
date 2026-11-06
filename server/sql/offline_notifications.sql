CREATE TABLE IF NOT EXISTS public.offline_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  license_id uuid,
  offline_since timestamptz NOT NULL,
  milestone_hours int NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, offline_since, milestone_hours)
);

ALTER TABLE public.offline_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS offline_notifications_deny_authenticated ON public.offline_notifications;

CREATE POLICY offline_notifications_deny_authenticated
  ON public.offline_notifications
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);
