DROP TRIGGER keyword_analysis_snapshots_insert_closed;
CREATE TRIGGER keyword_analysis_snapshots_insert_closed
BEFORE INSERT ON keyword_analysis_snapshots
BEGIN
  SELECT CASE WHEN
    NEW.marketplace NOT IN ('US', 'UK', 'DE', 'CA')
    OR json_type(NEW.asins_json) IS NOT 'array'
    OR json_array_length(NEW.asins_json) < 1
    OR NEW.asins_json IS NOT json(NEW.asins_json)
    OR json_type(NEW.sources_json) IS NOT 'array'
    OR json_array_length(NEW.sources_json) < 1
    OR NEW.sources_json IS NOT json(NEW.sources_json)
    OR json_type(NEW.payload_json) IS NOT 'object'
    OR json_type(NEW.payload_json, '$.groups') IS NOT 'array'
    OR json_array_length(NEW.payload_json, '$.groups') < 1
    OR json_type(NEW.payload_json, '$.evidence') IS NOT 'array'
    OR json_array_length(NEW.payload_json, '$.evidence') < 1
    OR NEW.payload_json IS NOT json(NEW.payload_json)
    OR length(NEW.content_hash) IS NOT 64
    OR NEW.content_hash IS NOT lower(NEW.content_hash)
    OR NEW.content_hash GLOB '*[^0-9a-f]*'
    OR NEW.data_cutoff_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', NEW.data_cutoff_at)
    OR NEW.created_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at)
  THEN RAISE(ABORT, 'invalid keyword analysis snapshot') END;
END;

