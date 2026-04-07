# Grafana & InfluxDB Upgrade Research

**Current versions:** Grafana v9.1.1, InfluxDB v2.3.0 (both mid-2022)
**Environment:** Docker on Synology NAS
**Research date:** April 2026

---

## 1. Latest Stable Versions (early 2026)

| Product | Latest Stable | Notes |
|---------|--------------|-------|
| **Grafana** | **v12.4.2** (released March 25, 2026) | Major versions 10, 11, 12 released since your v9.1.1 |
| **InfluxDB OSS v2** | **v2.8.0** | Final v2.x line; still maintained but labeled "earlier version" |
| **InfluxDB 3 Core** | **v3.x** (new product) | Completely rewritten engine; free/open-source self-hosted option |

---

## 2. InfluxDB: Detailed Upgrade Analysis

### Staying on InfluxDB v2 (v2.3.0 -> v2.8.0)

**Upgrade path:** Direct jump from v2.3.0 to v2.8.0 is supported. For Docker, simply change the image tag to `influxdb:2.8.0`. No intermediate versions needed.

**Breaking changes (v2.3 to v2.8):**
- Mostly incremental improvements; no major schema-breaking changes within the v2 line
- Flux query language remains fully supported in v2.8
- The v2 line uses the TSM storage engine throughout

**CRITICAL Docker warning:** On **May 27, 2026**, the `influxdb:latest` Docker tag will switch to InfluxDB 3 Core. If your Synology Docker Compose uses `influxdb:latest`, you MUST pin to `influxdb:2` or `influxdb:2.8.0` before that date to avoid an accidental migration to a completely different product.

### InfluxDB 3 Core (v3.x) -- NOT a simple upgrade

**InfluxDB 3 is a complete rewrite, not an upgrade from v2.** Key differences:

- **New storage engine:** Apache DataFusion + Apache Parquet format, with object storage support (S3, Azure Blob, GCS, or local filesystem)
- **Query languages:** SQL and InfluxQL supported. **Flux is NOT supported in v3.** All Flux queries must be rewritten in SQL or InfluxQL.
- **No direct data migration path from v2 to v3.** The storage formats (TSM vs Parquet) are incompatible. You would need to export data from v2 (e.g., via CSV or line protocol) and re-import into v3.
- **Write compatibility:** v3 Core supports v1 and v2 write compatibility APIs, so Telegraf and line-protocol writers can be pointed at v3 with minimal changes.
- **Docker image:** `influxdb:3-core` (available for AMD64 and ARM64)
- **No built-in UI/dashboards** like InfluxDB v2 had. You'd rely on Grafana or the new "InfluxDB 3 Explorer" tool.

### Recommendation for InfluxDB

**Stay on v2.8.0 for now.** The upgrade is painless. Pin your Docker tag to `influxdb:2.8.0` immediately to avoid the May 2026 tag switch. Moving to v3 is a migration project, not an upgrade -- only pursue it if you need the performance benefits and are willing to rewrite Flux queries and re-import data.

---

## 3. Grafana: Detailed Upgrade Analysis

### Upgrade Path: v9.1.1 -> v12.4.2

**Grafana supports direct jumps** -- you can go straight from v9.1.1 to v12.4.2. Grafana says upgrades are backward-compatible and "dashboards and graphs will not change." However, 3 major versions means several breaking changes to review.

### Major Breaking Changes by Version

#### v10.0 Breaking Changes
- **Angular plugin deprecation begins:** Angular-based plugins are deprecated. Angular support is still available but off by default for new Cloud stacks. Self-managed instances are not auto-affected yet, but this starts the clock.
- **Legacy alerting deprecated:** Dashboard alerts (legacy alerting) stop receiving contributions. Migration to Grafana Alerting is strongly recommended.
- **Dashboard previews feature removed** (was behind a feature flag since v9.0)
- **RBAC always enabled:** Role-based access control can no longer be disabled.

#### v11.0 Breaking Changes (MOST IMPACTFUL)
- **AngularJS support OFF by default for ALL instances** (including self-managed). Any Angular-based panel plugins or data source plugins will stop loading. You can temporarily re-enable with `angular_support_enabled=true` in config, but this option will be removed in v12.
  - Use the [`detect-angular-dashboards`](https://github.com/grafana/detect-angular-dashboards) tool to find affected dashboards.
  - Common Angular plugins needing replacement: old Graph panel (replaced by Time Series), Worldmap panel (replaced by Geomap), Table (old) panel (replaced by new Table).
- **Legacy alerting COMPLETELY REMOVED.** Grafana will **fail to start** if legacy alerting settings are still in your config. Migration is only possible up to v10.4.x -- after that it's too late.
  - **ACTION REQUIRED:** If you use legacy dashboard alerts, you MUST migrate to Grafana Alerting BEFORE upgrading past v10.4.

#### v12.0 Breaking Changes
- **Data source UID format enforcement:** UIDs must match the format `[a-zA-Z0-9-]` only. The `failWrongDSUID` feature flag is now ON by default. If you have data sources with UIDs containing underscores or special characters, they will be rejected on create/update.
- **Angular support fully removed** (the `angular_support_enabled` config option is gone).

### Dashboard JSON Schema
- Dashboard JSON is forward-compatible across these versions. Existing dashboards will load fine.
- Panels using deprecated Angular visualizations will show errors/warnings and need to be switched to their React replacements.

### Auth Changes
- No fundamental auth protocol changes, but RBAC is now mandatory (since v10). If you had it disabled, permissions are auto-migrated.

### Synology NAS / Docker Considerations
- Grafana Docker images work fine on Synology. The official `grafana/grafana:12.4.2` image supports AMD64 and ARM64.
- Ensure your Grafana data volume is mapped correctly so the SQLite database (or your configured DB) persists across container recreation.
- Grafana auto-runs database migrations on startup when upgrading.

---

## 4. Recommended Upgrade Steps

### InfluxDB (simple)
1. **Immediately:** Pin your Docker image to `influxdb:2` or `influxdb:2.8.0` to avoid the May 2026 tag switch
2. Back up your InfluxDB data directory
3. Update the image tag to `influxdb:2.8.0` and restart
4. Verify Flux queries and dashboards still work

### Grafana (requires care)
1. **Back up** your Grafana database (`grafana.db`) and any custom config files
2. **Check for Angular plugins:** Run `detect-angular-dashboards` tool against your v9.1.1 instance, or manually check your dashboards for old panel types (Graph, Table-old, Worldmap, etc.)
3. **If using legacy dashboard alerts:** Upgrade first to v10.4.x, migrate alerts to Grafana Alerting, verify everything works, THEN proceed to v12.
4. **If NOT using legacy alerts:** You can jump directly to v12.4.2
5. Update your Grafana config: remove any `angular_support_enabled` or legacy alerting settings
6. Replace Angular panel plugins with React equivalents (Graph -> Time Series, Table-old -> Table, etc.)
7. Pull `grafana/grafana:12.4.2` and restart
8. Check data source UIDs for invalid characters

### Upgrade Order
Upgrade InfluxDB first (it's lower risk), verify Grafana can still query it, then upgrade Grafana.

---

## 5. Risk Summary

| Risk | Severity | Mitigation |
|------|----------|------------|
| InfluxDB Docker `latest` tag changing May 2026 | **HIGH** | Pin to `influxdb:2.8.0` now |
| Legacy alerting removed in Grafana v11 | **HIGH** if using legacy alerts | Migrate alerts at v10.4 first |
| Angular plugins removed in Grafana v12 | **MEDIUM** | Replace with React equivalents |
| Data source UID enforcement in Grafana v12 | **LOW** | Check UIDs for special chars |
| InfluxDB v2 -> v3 migration | **N/A for now** | Stay on v2.8; evaluate v3 later |
