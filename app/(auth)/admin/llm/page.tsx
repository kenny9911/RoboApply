// /admin/llm — the LLM gateway: provider entries (name, API base URL, key,
// models) and the provider and model each functionality area uses.
// Admin only: the console checks the role and every API route enforces it.

import { LlmGatewayConsole } from '../../../../components/v3/admin';

export default function AdminLlmGatewayPage() {
  return <LlmGatewayConsole />;
}
