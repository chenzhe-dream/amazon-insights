# Four market modules on the existing local system

User-approved scope: add the four existing market modules while retaining the current PostgreSQL database, users, sessions, DingTalk and old workflows. No new VOC expansion and no remote publishing.

Imported market modules and required runtime seams from e338620a. Preserved the existing app/page.tsx market entry changes. Excluded unrelated old-module repair and launch-checklist changes. Corrected a stale overview notice and the test that still expected the other three module names to be absent.

Validation before switch:
- Production build passed in a staging copy based on the current formal worktree.
- Targeted suite initially passed 147/152; failures were missing staged skill files, React server test conditions, omitted shape CSS and the stale one-module test expectation. Skill/CSS files were included and failed paths rechecked: server runtime/overview 23/23; display 10/10; shape browser flow passed. Existing auth/DingTalk/project authorization and legacy model-budget cases passed.
- Restored the database backup into an isolated verification database, then applied the market migrations. User/project/session/run/job content digests were unchanged: 19 users, 61 projects, 98 sessions, 86 analysis runs, 63 sync jobs.
- Existing DingTalk configuration and the market model runtime initialized on the upgraded clone. No real source/model collection was triggered.

Backup and detailed validation logs: C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/backups/market-integration-20260914. This includes the original database dump, code baseline, uncommitted changes and original runtime configuration.

Original service: port 31900/31901; original PostgreSQL: port 58258. Post-switch checks recorded in the backup directory.
