CREATE OR REPLACE FUNCTION get_open_positions()
RETURNS SETOF trade_executions AS $$
  SELECT te.*
  FROM trade_executions te
  LEFT JOIN trade_closes tc ON tc.execution_id = te.id
  WHERE tc.id IS NULL
  ORDER BY te.opened_at DESC;
$$ LANGUAGE sql STABLE;
