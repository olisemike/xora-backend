// ============================================
// DATABASE ROUTER
// Central place to decide which physical database to use
// (primary, analytics, archive, etc.)
// ============================================

export class DbRouter {
  constructor(primaryDb, options = {}) {
    this.primaryDb = primaryDb;
    this.archiveDb = options.archiveDb || primaryDb;
    this.analyticsDb = options.analyticsDb || primaryDb;
  }

  static fromEnv(env) {
    return new DbRouter(env.DB, {
      // DB2 is secondary/analytics, DB3 is archive (per wrangler.toml)
      archiveDb: env.DB3 || env.DB_ARCHIVE,
      analyticsDb: env.DB2 || env.DB_ANALYTICS
    });
  }

  /**
   * Main database used for all reads/writes today.
   * In the future, we can route specific tables or tenants
   * to different physical databases.
   */
  getPrimaryDb() {
    return this.primaryDb;
  }

  /** Archive / cold-storage DB (if configured). */
  getArchiveDb() {
    return this.archiveDb || this.primaryDb;
  }

  /** Analytics / reporting DB (if configured). */
  getAnalyticsDb() {
    return this.analyticsDb || this.primaryDb;
  }

  /**
   * Hook for fine-grained routing by table + mode (read/write).
   * For now this always returns the primary DB so behaviour matches
   * the existing single-D1 deployment.
   */
  getDbForTable(tableName, { _mode = 'read' } = {}) {
    return this.primaryDb;
  }
}
