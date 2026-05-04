UPDATE companies
SET project_name = target,
    target = NULL
WHERE target ILIKE '%project%'
  AND project_name IS NULL;
