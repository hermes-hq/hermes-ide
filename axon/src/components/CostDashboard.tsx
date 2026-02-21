import { useState, useEffect, useMemo } from "react";
import type { CostDailyEntry, ProjectCostEntry } from "../types";
import { getCostHistory, getCostByProject } from "../api/costs";

interface CostDashboardProps {
  onClose: () => void;
}

function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

export function CostDashboard({ onClose }: CostDashboardProps) {
  const [days, setDays] = useState(7);
  const [dailyCosts, setDailyCosts] = useState<CostDailyEntry[]>([]);
  const [projectCosts, setProjectCosts] = useState<ProjectCostEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getCostHistory(days).then((entries) => setDailyCosts(entries)).catch((err) => console.warn("[CostDashboard] Failed to load cost history:", err)),
      getCostByProject(days).then((entries) => setProjectCosts(entries)).catch((err) => console.warn("[CostDashboard] Failed to load project costs:", err)),
    ]).finally(() => setLoading(false));
  }, [days]);

  const { dailyTotals, maxDailyCost, totalCost } = useMemo(() => {
    const byDate: Record<string, number> = {};
    let total = 0;
    for (const entry of dailyCosts) {
      byDate[entry.date] = (byDate[entry.date] || 0) + entry.total_cost_usd;
      total += entry.total_cost_usd;
    }
    const entries = Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b));
    const max = entries.length > 0 ? Math.max(...entries.map(([, v]) => v)) : 0;
    return { dailyTotals: entries, maxDailyCost: max, totalCost: total };
  }, [dailyCosts]);

  const providerBreakdown = useMemo(() => {
    const byProvider: Record<string, number> = {};
    for (const entry of dailyCosts) {
      byProvider[entry.provider] = (byProvider[entry.provider] || 0) + entry.total_cost_usd;
    }
    return Object.entries(byProvider).sort(([, a], [, b]) => b - a);
  }, [dailyCosts]);

  const projectBreakdown = useMemo(() => {
    const byProject: Record<string, number> = {};
    for (const entry of projectCosts) {
      const name = entry.working_directory.split("/").pop() || entry.working_directory;
      byProject[name] = (byProject[name] || 0) + entry.total_cost_usd;
    }
    return Object.entries(byProject).sort(([, a], [, b]) => b - a);
  }, [projectCosts]);

  const maxProjectCost = projectBreakdown.length > 0 ? projectBreakdown[0][1] : 0;

  const isEmpty = dailyCosts.length === 0 && projectCosts.length === 0;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="cost-dashboard" onClick={(e) => e.stopPropagation()}>
        <div className="cost-dashboard-header">
          <h2 className="cost-dashboard-title">Cost Dashboard</h2>
          <div className="cost-dashboard-tabs">
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                className={`cost-tab ${days === d ? "cost-tab-active" : ""}`}
                onClick={() => setDays(d)}
              >
                {d}d
              </button>
            ))}
          </div>
          <button className="close-btn cost-dashboard-close" onClick={onClose}>&times;</button>
        </div>

        {loading ? (
          <div className="cost-dashboard-empty">
            Loading cost data...
          </div>
        ) : isEmpty ? (
          <div className="cost-dashboard-empty">
            Cost data appears when AI providers report token usage.
          </div>
        ) : (
          <div className="cost-dashboard-body">
            {/* Total */}
            <div className="cost-summary">
              Total: <span className="cost-summary-amount">{formatCost(totalCost)}</span>
              <span className="cost-summary-period"> over {days} days</span>
            </div>

            {/* Daily cost bars */}
            {dailyTotals.length > 0 && (
              <div className="cost-section">
                <div className="cost-section-title">Daily</div>
                {dailyTotals.map(([date, cost]) => (
                  <div key={date} className="cost-bar-row">
                    <span className="cost-bar-label mono">{date.slice(5)}</span>
                    <div className="ctx-tool-bar-track">
                      <div
                        className="ctx-tool-bar-fill"
                        style={{ width: `${maxDailyCost > 0 ? (cost / maxDailyCost) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="cost-bar-value mono">{formatCost(cost)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Provider breakdown */}
            {providerBreakdown.length > 0 && (
              <div className="cost-section">
                <div className="cost-section-title">By Provider</div>
                {providerBreakdown.map(([provider, cost]) => (
                  <div key={provider} className="cost-bar-row">
                    <span className="cost-bar-label">{provider}</span>
                    <div className="ctx-tool-bar-track">
                      <div
                        className="ctx-tool-bar-fill cost-bar-provider"
                        style={{ width: `${totalCost > 0 ? (cost / totalCost) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="cost-bar-value mono">{formatCost(cost)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Project breakdown */}
            {projectBreakdown.length > 0 && (
              <div className="cost-section">
                <div className="cost-section-title">By Project</div>
                {projectBreakdown.map(([project, cost]) => (
                  <div key={project} className="cost-bar-row">
                    <span className="cost-bar-label mono truncate">{project}</span>
                    <div className="ctx-tool-bar-track">
                      <div
                        className="ctx-tool-bar-fill cost-bar-project"
                        style={{ width: `${maxProjectCost > 0 ? (cost / maxProjectCost) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="cost-bar-value mono">{formatCost(cost)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
