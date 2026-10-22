-- How many accounts have installed each market App, for the market's listing and product pages.
--
-- The figure is a lower bound on a 1/5 ladder per decade (1, 5, 10, 50, 100, 500, ...), the way app stores
-- show install counts: 1-4 accounts read as 1, 5-9 as 5, 10-49 as 10. Exact counts and who installed never
-- leave the database. chat.app_installs keeps one row per account and App (its primary key), recorded on the
-- first install; uninstalls are not recorded, so this counts accounts that installed the App at least once.
-- Deleting an account deletes its rows (ON DELETE CASCADE), which lowers the count.
--
-- The table is untouched: RLS stays on with no policies and only service_role holds table privileges, so
-- clients still cannot read rows. Like chat.market_install_ranking, this definer function is the only read.
CREATE FUNCTION chat.market_install_counts()
RETURNS TABLE(app_id text, installs bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT c.app_id,
         CASE WHEN c.accounts >= 5 * s.step THEN 5 * s.step ELSE s.step END
    FROM (SELECT i.app_id, count(*) AS accounts
            FROM chat.app_installs i
           WHERE i.app_publisher = 'gugu'
           GROUP BY i.app_id) c
   CROSS JOIN LATERAL (SELECT pg_catalog.power(10, pg_catalog.length(c.accounts::text) - 1)::bigint AS step) s;
$$;
REVOKE ALL ON FUNCTION chat.market_install_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.market_install_counts() TO authenticated;
