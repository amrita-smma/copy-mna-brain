/**
 * Fetch pipeline secrets from SSM Parameter Store at Lambda cold start.
 * Falls back gracefully if SSM_PREFIX is not set (local / SAM testing —
 * secrets come directly from env vars in template.local.yaml).
 *
 * Call once at the top of each Lambda handler before any other logic.
 */
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';

let loaded = false;

export async function loadSecretsFromSsm(): Promise<void> {
  if (loaded) return;

  const prefix = process.env.SSM_PREFIX;
  if (!prefix) {
    // Local / SAM — secrets already in env vars, nothing to do.
    loaded = true;
    return;
  }

  const client = new SSMClient({ region: process.env.AWS_REGION ?? 'ap-southeast-3' });
  const command = new GetParametersByPathCommand({
    Path: prefix,
    WithDecryption: true,
    Recursive: false,
  });

  const response = await client.send(command);
  for (const param of response.Parameters ?? []) {
    if (!param.Name || param.Value === undefined) continue;
    // Strip the prefix to get the bare key (e.g. /mna/staging/pipeline/ANTHROPIC_API_KEY → ANTHROPIC_API_KEY)
    const key = param.Name.replace(`${prefix}/`, '');
    if (key && !process.env[key]) {
      process.env[key] = param.Value;
    }
  }

  loaded = true;
}
