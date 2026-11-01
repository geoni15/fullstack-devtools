import type { InspectionSqlQuery } from '@bdt/protocol';
import type { StaticRoute, StaticSqlSite } from '@bdt/routes-index';
import { analyzeSql } from '@bdt/sql-analyzer';

export function normalizeSqlText(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function joinNotes(notes: ReadonlyArray<string | null>): string | null {
  const parts = notes.filter((note): note is string => note !== null && note !== '');
  return parts.length === 0 ? null : parts.join(' · ');
}

export function staticQueriesForRoute(route: StaticRoute): InspectionSqlQuery[] {
  const sites = new Map<string, StaticSqlSite>();
  for (const site of route.sqlSites) {
    if (!sites.has(site.id)) {
      sites.set(site.id, site);
    }
  }
  const lineCounts = new Map<number, number>();
  for (const site of sites.values()) {
    lineCounts.set(site.line, (lineCounts.get(site.line) ?? 0) + 1);
  }

  const queries: InspectionSqlQuery[] = [];
  for (const site of sites.values()) {
    const sharedNote =
      (lineCounts.get(site.line) ?? 0) > 1 ? 'Varias llamadas SQL comparten esta línea.' : null;
    if (site.sql === null) {
      continue;
    }

    for (const analysis of analyzeSql(site.sql)) {
      if (
        analysis.parse !== 'ast' &&
        analysis.tablesRead.length === 0 &&
        analysis.tablesWritten.length === 0
      ) {
        continue;
      }
      queries.push({
        id: site.id,
        status: 'possible',
        operation: analysis.operation,
        tablesRead: [...analysis.tablesRead],
        tablesWritten: [...analysis.tablesWritten],
        columns: analysis.columns.map((column) => ({ ...column })),
        dialect: analysis.dialect,
        parse: analysis.parse,
        selectStar: analysis.selectStar,
        sql: site.sql,
        dynamic: false,
        line: site.line,
        column: site.column,
        callMethod: site.method,
        callObject: site.objectName,
        note: joinNotes([site.note, analysis.note, sharedNote]),
        observedAt: null,
      });
    }
  }
  return queries;
}
