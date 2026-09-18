import type { AgentStatus } from "./agent.ts";

const pct = (n: number, d: number): string => (d === 0 ? "-" : `${Math.round((100 * n) / d)}%`);

export function renderStatus(s: AgentStatus): string {
  const st = s.stats;
  const d = s.lastDecision;
  const conf = d?.confidence === null || d?.confidence === undefined ? "" : ` ${d.confidence.toFixed(2)}`;
  const posture = s.posture ? ` posture=${s.posture}` : "";
  const goal: string[] = [];
  if (s.goal.targetLevel > 0) goal.push(`level ${s.goal.targetLevel}`);
  if (s.goal.targetScore > 0) goal.push(`score ${s.goal.targetScore}`);
  if (s.goal.secondsLeft !== null) goal.push(`${s.goal.secondsLeft}s left`);
  if (s.goal.runsLeft !== null) goal.push(`${s.goal.runsLeft} game(s) left`);
  const parts = [
    `game ${s.run}`,
    s.phase,
    `score ${s.score}`,
    `level ${s.level} (${s.linesToNext} to next)`,
    `pieces ${s.pieces} lines ${s.lines}`,
    goal.length ? `goal ${goal.join(", ")}` : "goal none",
    `${s.brain}`,
    `rtt ${Math.round(s.latencyP50)}/${Math.round(s.latencyP90)}ms`,
    `${s.requestsPerSecond.toFixed(1)} req/s`,
    `applied ${pct(st.applied, st.answers)} preplanned ${st.preplanHits}/${st.preplanHits + st.preplanMisses} stale ${st.stale} late ${st.late} veto ${st.vetoed} err ${st.errors}`,
    `placed jev ${st.placedByJev} code ${st.placedByCode} failed ${st.execFailed}`,
    `last ${s.lastChoice ?? "-"}${conf}${posture}`,
  ];
  if (s.adMessage) parts.push(`ads: ${s.adMessage}`);
  if (s.message) parts.push(`| ${s.message}`);
  return parts.join(" | ");
}

export class Hud {
  private timer: NodeJS.Timeout | null = null;
  private lastLine = "";
  private readonly interactive = Boolean(process.stdout.isTTY);

  start(status: () => AgentStatus, intervalMs = 250): void {
    this.timer = setInterval(() => this.draw(status()), this.interactive ? intervalMs : 1000);
  }

  draw(s: AgentStatus): void {
    const line = renderStatus(s);
    if (line === this.lastLine) return;
    this.lastLine = line;
    if (this.interactive) process.stdout.write(`\r\x1b[2K${line.slice(0, (process.stdout.columns ?? 200) - 1)}`);
    else console.log(line);
  }

  println(text: string): void {
    if (this.interactive) process.stdout.write(`\r\x1b[2K${text}\n`);
    else console.log(text);
    this.lastLine = "";
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.interactive) process.stdout.write("\n");
  }
}
