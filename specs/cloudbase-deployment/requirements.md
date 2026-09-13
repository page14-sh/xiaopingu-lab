# Xiaopingu CloudBase Deployment Requirements

## Scope

- Deploy the existing static Web application to CloudBase.
- Replace the local JSON persistence layer with CloudBase NoSQL collections.
- Preserve the current Supabase-compatible REST paths used by the Web and mini program clients.
- Configure the mini program to use the deployed API for development, without uploading or publishing it to WeChat.
- Do not migrate `server/local-data.json`; only seed the two hard-coded demonstration counselors.

## Acceptance criteria

1. When the CloudRun API is deployed, the system shall return a fixed successful response from `/health`.
2. When a visitor submits an assessment, the system shall persist it in the `assessments` CloudBase collection.
3. When a public caller reads counselors, the system shall return only active, approved profiles and omit non-public contact details and edit tokens.
4. When an administrator supplies the correct server-side password, the system shall issue an expiring session token and allow administrative reads and writes.
5. When a counselor supplies a valid edit token, the system shall issue an expiring session token scoped to that counselor.
6. When the Web app is deployed, all API calls shall use the CloudBase HTTPS gateway URL.
7. When the mini program is run in its current demo mode, it shall use the CloudBase API URL; publishing to WeChat shall remain out of scope.
8. The deployment shall not expose runtime credentials, request headers, environment variables, or `x-cloudbase-context`.

## Non-goals

- Production WeChat OPENID integration or mini program publishing.
- Custom domains, ICP filing, or custom TLS certificates.
- Migrating local assessment, session, rating, visitor, or contact data.
- Enabling CloudRun.
