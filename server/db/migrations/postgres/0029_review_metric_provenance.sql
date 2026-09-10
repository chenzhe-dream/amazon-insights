DO $migration$
DECLARE
  function_sql TEXT;
  prior_sql TEXT;
BEGIN
  SELECT pg_get_functiondef('enforce_voc_data_snapshot_insert()'::regprocedure)
    INTO function_sql;

  prior_sql := function_sql;
  function_sql := replace(function_sql, 'OR (record_value ->> ''sampledReviews'')::numeric < 1', 'OR (record_value ->> ''sampledReviews'')::numeric < 0');
  IF function_sql = prior_sql THEN
    RAISE EXCEPTION 'review metric provenance migration could not locate sampled review validator';
  END IF;

  prior_sql := function_sql;
  function_sql := replace(function_sql, 'OR jsonb_object_key_count(row_value) <> 3', 'OR jsonb_object_key_count(row_value) NOT BETWEEN 3 AND 6');
  IF function_sql = prior_sql THEN
    RAISE EXCEPTION 'review metric provenance migration could not locate row size validator';
  END IF;

  prior_sql := function_sql;
  function_sql := replace(function_sql, 'WHERE field.key NOT IN (''label'', ''sharePct'', ''reason'')', 'WHERE field.key NOT IN (''label'', ''sharePct'', ''reason'', ''metricKind'', ''numerator'', ''denominator'')');
  IF function_sql = prior_sql THEN
    RAISE EXCEPTION 'review metric provenance migration could not locate row key validator';
  END IF;

  prior_sql := function_sql;
  function_sql := replace(
    function_sql,
    'OR jsonb_typeof(row_value -> ''reason'') <> ''string''',
    $validation$OR jsonb_typeof(row_value -> 'reason') <> 'string'
          OR (
            (row_value ? 'metricKind' OR row_value ? 'numerator' OR row_value ? 'denominator')
            AND (
              jsonb_object_key_count(row_value) <> 6
              OR jsonb_typeof(row_value -> 'metricKind') <> 'string'
              OR row_value ->> 'metricKind' NOT IN ('review_sample_incidence', 'customers_say_topic_share')
              OR jsonb_typeof(row_value -> 'numerator') <> 'number'
              OR (row_value ->> 'numerator') !~ '^\d+$'
              OR jsonb_typeof(row_value -> 'denominator') <> 'number'
              OR (row_value ->> 'denominator') !~ '^[1-9]\d*$'
              OR (row_value ->> 'numerator')::numeric > (row_value ->> 'denominator')::numeric
              OR (
                row_value ->> 'metricKind' = 'review_sample_incidence'
                AND (row_value ->> 'denominator')::numeric <> (record_value ->> 'sampledReviews')::numeric
              )
              OR abs(
                (row_value ->> 'sharePct')::numeric -
                ((row_value ->> 'numerator')::numeric / (row_value ->> 'denominator')::numeric) * 100
              ) > 0.0050001
            )
          )$validation$
  );
  IF function_sql = prior_sql THEN
    RAISE EXCEPTION 'review metric provenance migration could not locate row value validator';
  END IF;

  EXECUTE function_sql;
END;
$migration$;
