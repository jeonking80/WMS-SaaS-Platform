# V2 masters contract

Additive migration `1792368000012_v2-masters.sql` preserves legacy masters.

- `locations.kind`: `RECEIVING | STORAGE | STAGING | SHIPPING | HOLD`, default STORAGE.
- `locations.priority`: nonnegative integer, default 100. `locations.reservation_blocked`: boolean default false.
- `items.search_terms`: text default ''; `items.base_unit`: fixed EA.
- `business_partners`: tenant scoped `id,code,name,supplier,customer,external_code,active`; both roles allowed; at least one required.
- Existing `delivery_destinations` gets `partner_id` nullable composite FK, `external_code,contact_name,phone` default ''. Historical rows preserved.
- `master_barcodes`: `id,tenant_id,barcode,item_id?,location_id?,unit(EA|BOX)?,quantity?`; one target only. Item EA=1, BOX integer 2..1e9. Tenant barcode globally unique including locations. Target/unit/quantity/barcode immutable after insert; active may change. Never reuse retired barcode.
- All new tables FORCE RLS and composite tenant FKs.

API `/api/v2/masters/[kind]` kinds `items,locations,partners,destinations,barcodes`; GET requires `warehouse_id`, optional `q,active`, returns `{ rows }` (max 1000); POST same `warehouse_id` query + JSON fields returns `{ row }`. PATCH `/[kind]/[id]` returns `{ row }`. No delete; PATCH active false blocked on stock/reservation/open work. Warehouse context mandatory even for company masters. Creation fields snake_case match columns; location requires warehouse_id only in query; barcode item target `item_id,barcode,unit,quantity` or location target `location_id,barcode`.

CSV POST `/api/v2/masters/[kind]/csv/preview?warehouse_id=...` body `{csv,request_key}` -> `{preview_id,rows:[{row_number,data,errors:[]}]}`. Max 1000 rows; headers match create fields. Apply POST `/csv/apply` `{preview_id,row_numbers:[2,...],request_key}` -> `{rows,applied}`; only explicitly selected valid rows, atomic, retried keys return same result; conflicting payloads rejected. GET `/export?warehouse_id=...&q=&active=` produces formula-safe CSV with metadata, captured transactional snapshot and same filters/warehouse access. Preview errors CSV GET `/csv/errors?preview_id=...&warehouse_id=...`.

Service exports `resolveBarcode(client, barcode)` returning immutable target/unit/quantity (active targets only), `assertMasterUnused(client,kind,id)` with extension hook for workflow. Workflow must check active item/location/partner and warehouse membership at mutation time while holding SHARE reference locks. Master patch locks parent reference UPDATE to serialize inactivity checks.

## Receipt/order CSV

The same CSV routes additionally accept `receipts` and `orders` (permission `write`). Headers: `external_id,item_code,quantity` plus receipt `supplier_code,expected_at`, or order `customer_code,destination_external_code,due_at`. Dates must be valid ISO date/time. Order `recipient,delivery` columns are optional and the authoritative saved snapshot comes from the selected active destination belonging to the selected customer. Codes resolve active tenant masters. Supplier must have supplier role; customer must have customer role. Destination snapshots resolve by its external code and must match supplied customer.

Rows sharing `external_id` create one document, max 100 distinct item rows. All header/snapshot values in that document must match. Any invalid row invalidates the document group. Apply must select the entire valid group (`GROUP_SELECTION_REQUIRED` otherwise). Max upload 1000 rows. Every selected document and applied-row marker commits in one transaction via `executeWorkflowInTransaction`; partial failures roll back all selected documents. The workflow's tenant/kind/external-id uniqueness also covers manual/API creates. Retried previews/applies preserve original results, and repeated selected rows under a new request key add no duplicate effects.

Business CSV `quantity` is integer EA (base units). Master exports include `record_type` and `row_count`; a zero-result export contains one `record_type=metadata` row so its tenant, warehouse, captured time and active/search filters remain visible. Data exports read the complete filtered set in one statement snapshot, without page-boundary skips or duplicates.

Every preview row includes a stable SHA-256 `request_key`. Applied master results retain `row_number` and that key; grouped business results retain `row_numbers` and `request_keys`, allowing the operator to correlate retries and outcomes to the original upload rows.

CSV code aliases are resolved by the server under tenant RLS: barcode rows accept `item_code` or `location_code` (location codes also require the selected warehouse), and destination rows accept `customer_code` or `partner_code`. The partner must be active with customer role. Mixing nonempty ID and code inputs, or conflicting partner aliases, is rejected. Normal JSON APIs continue to use selected internal IDs.

## Complete paginated catalogs

Collection GET keeps `rows` and adds `has_more:boolean`, `next_cursor:string|null`. `limit` defaults to1000 and accepts integers1..1000. Follow `cursor=<next_cursor>` with identical tenant, warehouse, kind, q, active and limit. A cursor is only a continuation boundary; every request rechecks live role/warehouse authorization and PostgreSQL RLS. A changed scope/filter/limit or malformed cursor returns400. Permission withdrawal returns403 before data is read. UUID keyset order avoids offset duplicates. These are live pages, so refresh after catalog changes; this is not a frozen cross-request snapshot. Filtered CSV exports retain their single-statement full-set behavior.

`src/app/dashboard/v2/master-pages.ts:loadAllMasters` collects every bounded page while preserving filters. It refuses missing continuation metadata, duplicate IDs, stalled cursors and later-page failures instead of exposing a partial catalog. Operational bootstrap/reload and the master search tab use this helper. Five catalogs become an operational context only after all finish. Catalog request generations are separate from workflow snapshot refreshes. A100SKU catalog still uses one request per kind.

Validation: master unit13 (including collector boundary/error cases), real PostgreSQL masters14 (each of five kinds1001→1000+1, foreign tenant/warehouse exclusion, filter/limit/kind cursor mismatch, live grant withdrawal) and TypeScript passed. Browser regression and new-build performance measurements remain separate evidence.
