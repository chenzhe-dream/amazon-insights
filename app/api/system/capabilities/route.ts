import { getSystemCapabilities } from "../../../lib/system-capabilities";

export async function GET() {
  return Response.json(getSystemCapabilities());
}
