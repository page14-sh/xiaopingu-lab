# Implementation Plan

- [x] 1. Implement the CloudRun API service
  - Add NoSQL persistence, capability checks, admin/counselor sessions, and CORS.
  - Add packaging and local test support.
  - _Requirements: 1-5, 8_

- [x] 2. Update Web and mini program configuration
  - Route clients to the CloudBase gateway URL.
  - Replace client-only admin authentication with server verification.
  - Preserve the existing REST-compatible frontend helpers.
  - _Requirements: 4, 6, 7_

- [x] 3. Prepare CloudBase resources
  - Create five private NoSQL collections and useful indexes.
  - Create a dedicated server API key and seed only demonstration counselors.
  - _Requirements: 2, 3, 8_

- [x] 4. Deploy and expose the API
  - Open CloudRun Trial, deploy the container with injected secrets, and enable public HTTPS access.
  - Verify service detail, process logs, and live API behavior.
  - _Requirements: 1-5, 8_

- [x] 5. Deploy and validate the Web app
  - Bundle `web/` into CloudRun, integrate the protected admin workspace into the homepage, and verify the public routes.
  - Document URLs and local/mini-program run instructions.
  - Run the CloudBase review checklist.
  - _Requirements: 6-8_
