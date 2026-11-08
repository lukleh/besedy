-- Structural fingerprint excludes migration bookkeeping, owners, grants and
-- extension-owned functions. It includes SQL-only invariants Prisma cannot diff.
SELECT encode(sha256(convert_to(
  COALESCE(jsonb_agg(to_jsonb(objects) ORDER BY kind, name, definition)::text, '[]'),
  'UTF8'
)), 'hex') AS fingerprint
FROM (
  SELECT 'table' AS kind, c.relname::text AS name,
    jsonb_build_object(
      'columns', (
        SELECT jsonb_agg(jsonb_build_object(
          'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
          'not_null', a.attnotnull, 'identity', a.attidentity,
          'default', pg_get_expr(d.adbin, d.adrelid), 'generated', a.attgenerated
        ) ORDER BY a.attnum)
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      ), 'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity,
      'options', c.reloptions
    )::text AS definition
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    AND c.relname <> '_prisma_migrations'
  UNION ALL
  SELECT 'constraint', c.conrelid::regclass::text || '.' || c.conname,
    pg_get_constraintdef(c.oid)
  FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE n.nspname = 'public' AND c.conrelid <> 'public._prisma_migrations'::regclass
  UNION ALL
  SELECT 'index', c.relname::text,
    jsonb_build_array(pg_get_indexdef(c.oid), i.indisvalid, i.indisready, i.indislive)::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_index i ON i.indexrelid = c.oid
  WHERE n.nspname = 'public' AND i.indrelid <> 'public._prisma_migrations'::regclass
  UNION ALL
  SELECT 'function', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND NOT EXISTS (
    SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
      AND d.objid = p.oid AND d.deptype = 'e'
  )
  UNION ALL
  SELECT 'trigger', t.tgrelid::regclass::text || '.' || t.tgname,
    jsonb_build_array(pg_get_triggerdef(t.oid), t.tgenabled)::text
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal
  UNION ALL
  SELECT 'view', c.relname::text, pg_get_viewdef(c.oid)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
  UNION ALL
  SELECT 'enum', t.typname::text,
    jsonb_agg(e.enumlabel ORDER BY e.enumlabel COLLATE "C")::text
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE n.nspname = 'public' GROUP BY t.typname
  UNION ALL
  SELECT 'sequence', c.relname::text,
    jsonb_build_array(s.seqtypid::regtype::text, s.seqstart, s.seqincrement,
                     s.seqmax, s.seqmin, s.seqcache, s.seqcycle)::text
  FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'policy', p.polrelid::regclass::text || '.' || p.polname,
    jsonb_build_array(p.polcmd, p.polpermissive, p.polroles,
                     pg_get_expr(p.polqual, p.polrelid),
                     pg_get_expr(p.polwithcheck, p.polrelid))::text
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
) objects;
