// Templates only: never log user IDs, query strings, cookies or submitted values.
export const ADMIN_READ_WRITE_ROUTES = new Set([
  '/v1/auth/session', '/v1/admin/users', '/v1/admin/usage', '/v1/admin/usage/people',
  '/v1/admin/module-visibility', '/v1/admin/module-visibility/defaults',
  '/v1/admin/module-visibility/:userId',
]);
