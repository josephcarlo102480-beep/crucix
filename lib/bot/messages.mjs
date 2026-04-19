export function formatUtcTime(value) {
  if (!value) return 'never';
  return new Date(value).toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
}

export function getNextSweepTime(lastSweepTime, refreshIntervalMinutes) {
  if (!lastSweepTime) return 'pending';
  return formatUtcTime(new Date(new Date(lastSweepTime).getTime() + refreshIntervalMinutes * 60000));
}

export function buildStatusSnapshot({
  startTime,
  currentData,
  llmProvider,
  lastSweepTime,
  refreshIntervalMinutes,
  sweepInProgress,
  sseClientCount,
  port,
}) {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  return {
    uptimeHours: Math.floor(uptime / 3600),
    uptimeMinutes: Math.floor((uptime % 3600) / 60),
    sourcesOk: currentData?.meta?.sourcesOk || 0,
    sourcesTotal: currentData?.meta?.sourcesQueried || 0,
    sourcesFailed: currentData?.meta?.sourcesFailed || 0,
    llmStatus: llmProvider?.isConfigured ? `enabled (${llmProvider.name})` : 'disabled',
    lastSweep: formatUtcTime(lastSweepTime),
    nextSweep: getNextSweepTime(lastSweepTime, refreshIntervalMinutes),
    sweepInProgress,
    sseClientCount,
    dashboardUrl: `http://localhost:${port}`,
  };
}

export function formatTelegramStatus(snapshot) {
  return [
    '🖥️ *CRUCIX STATUS*',
    '',
    `Uptime: ${snapshot.uptimeHours}h ${snapshot.uptimeMinutes}m`,
    `Last sweep: ${snapshot.lastSweep}`,
    `Next sweep: ${snapshot.nextSweep}`,
    `Sweep in progress: ${snapshot.sweepInProgress ? '🔄 Yes' : '⏸️ No'}`,
    `Sources: ${snapshot.sourcesOk}/${snapshot.sourcesTotal} OK${snapshot.sourcesFailed > 0 ? ` (${snapshot.sourcesFailed} failed)` : ''}`,
    `LLM: ${snapshot.llmStatus}`,
    `SSE clients: ${snapshot.sseClientCount}`,
    `Dashboard: ${snapshot.dashboardUrl}`,
  ].join('\n');
}

export function formatDiscordStatus(snapshot) {
  return [
    '**🖥️ CRUCIX STATUS**\n',
    `Uptime: ${snapshot.uptimeHours}h ${snapshot.uptimeMinutes}m`,
    `Last sweep: ${snapshot.lastSweep}`,
    `Next sweep: ${snapshot.nextSweep}`,
    `Sweep in progress: ${snapshot.sweepInProgress ? '🔄 Yes' : '⏸️ No'}`,
    `Sources: ${snapshot.sourcesOk}/${snapshot.sourcesTotal} OK${snapshot.sourcesFailed > 0 ? ` (${snapshot.sourcesFailed} failed)` : ''}`,
    `LLM: ${snapshot.llmStatus}`,
    `SSE clients: ${snapshot.sseClientCount}`,
    `Dashboard: ${snapshot.dashboardUrl}`,
  ].join('\n');
}

export function buildBriefSnapshot({ currentData, delta, now = new Date().toISOString() }) {
  const tg = currentData?.tg || {};
  const energy = currentData?.energy || {};
  const ideas = (currentData?.ideas || []).slice(0, 3);
  const vix = currentData?.fred?.find((f) => f.id === 'VIXCLS');
  const hy = currentData?.fred?.find((f) => f.id === 'BAMLH0A0HYM2');

  return {
    generatedAt: now.replace('T', ' ').substring(0, 19) + ' UTC',
    direction: delta?.summary?.direction || null,
    totalChanges: delta?.summary?.totalChanges || 0,
    criticalChanges: delta?.summary?.criticalChanges || 0,
    vix: vix?.value || '--',
    hySpread: hy?.value || null,
    wti: energy.wti || '--',
    brent: energy.brent || '--',
    natgas: energy.natgas || '--',
    urgentPosts: tg.urgent || [],
    totalPosts: tg.posts || 0,
    ideas,
  };
}

export function formatTelegramBrief(snapshot) {
  const sections = [
    '📋 *CRUCIX BRIEF*',
    `_${snapshot.generatedAt}_`,
    '',
  ];

  appendBriefSections(sections, snapshot, {
    bold: (value) => `*${value}*`,
    bullet: '  • ',
    ideaIcon: ideaIconFor,
  });

  return sections.join('\n');
}

export function formatDiscordBrief(snapshot) {
  const sections = [
    `**📋 CRUCIX BRIEF**\n_${snapshot.generatedAt}_\n`,
  ];

  appendBriefSections(sections, snapshot, {
    bold: (value) => `**${value}**`,
    bullet: '  • ',
    ideaIcon: ideaIconFor,
  });

  return sections.join('\n');
}

function appendBriefSections(sections, snapshot, fmt) {
  if (snapshot.direction) {
    const dirEmoji = { 'risk-off': '📉', 'risk-on': '📈', mixed: '↔️' }[snapshot.direction] || '↔️';
    sections.push(`${dirEmoji} Direction: ${fmt.bold(snapshot.direction.toUpperCase())} | ${snapshot.totalChanges} changes, ${snapshot.criticalChanges} critical`);
    sections.push('');
  }

  if (snapshot.vix !== '--' || snapshot.wti !== '--') {
    sections.push(`📊 VIX: ${snapshot.vix} | WTI: $${snapshot.wti} | Brent: $${snapshot.brent}`);
    if (snapshot.hySpread) sections.push(`   HY Spread: ${snapshot.hySpread} | NatGas: $${snapshot.natgas}`);
    sections.push('');
  }

  if (snapshot.urgentPosts.length > 0) {
    sections.push(`📡 OSINT: ${snapshot.urgentPosts.length} urgent signals, ${snapshot.totalPosts} total posts`);
    for (const post of snapshot.urgentPosts.slice(0, 2)) {
      sections.push(`${fmt.bullet}${(post.text || '').substring(0, 80)}`);
    }
    sections.push('');
  }

  if (snapshot.ideas.length > 0) {
    sections.push(`${fmt.bold('💡 Top Ideas:')}`);
    for (const idea of snapshot.ideas) {
      sections.push(`  ${fmt.ideaIcon(idea.type)} ${idea.title}`);
    }
  }
}

function ideaIconFor(type) {
  return type === 'long' ? '📈' : type === 'hedge' ? '🛡️' : '👁️';
}
