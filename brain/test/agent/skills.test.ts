import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkillCatalog, similarity } from '../../src/agent/skills.js';

/** A fake ~/.claude with one user skill, one installed plugin (2 skills + 1 command) and a marketplace. */
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'coco-skills-'));
  const claude = join(home, '.claude');
  const skill = (dir: string, name: string, description: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: >\n  ${description}\n---\n\n# body\n`);
  };
  skill(join(claude, 'skills', 'api-design'), 'api-design', 'REST API design patterns including resource naming and status codes.');
  const rca = join(claude, 'plugins', 'cache', 'meesho-skills', 'meesho-devops-rca', '1.0.2');
  skill(join(rca, 'skills', 'devops-rca'), 'devops-rca', 'MANDATORY AUTO-INVOKE for any Meesho infrastructure / health-check failure: pod failures, CrashLoop, OOM, 5xx, latency.');
  skill(join(rca, 'skills', 'devops-rca-setup'), 'devops-rca-setup', 'First-run orchestrator for the meesho-devops-rca plugin.');
  mkdirSync(join(rca, 'commands'), { recursive: true });
  writeFileSync(join(rca, 'commands', 'rca-ticket.md'), '---\ndescription: Raise a DevOps ticket from an RCA\n---\nbody');
  mkdirSync(join(claude, 'plugins'), { recursive: true });
  writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'meesho-devops-rca@meesho-skills': [{ scope: 'user', installPath: rca, version: '1.0.2' }] },
  }));
  const mp = join(claude, 'plugins', 'marketplaces', 'meesho-skills', '.claude-plugin');
  mkdirSync(mp, { recursive: true });
  writeFileSync(join(mp, 'marketplace.json'), JSON.stringify({
    name: 'meesho-skills',
    plugins: [
      { name: 'meesho-devops-rca', description: 'DevOps RCA' },
      { name: 'meesho-grafana', description: 'Grafana debugging skill for the Meesho engineering organization.' },
      { name: 'meesho-kibana', description: 'Kibana log analysis skill.' },
    ],
  }));
  return home;
}

describe('similarity', () => {
  it('tolerates speech-recognition misspellings', () => {
    expect(similarity('misho', 'meesho')).toBeGreaterThanOrEqual(0.6);
    expect(similarity('rca', 'rca')).toBe(1);
    expect(similarity('grafana', 'kibana')).toBeLessThan(0.6);
  });
});

describe('SkillCatalog', () => {
  const cat = new SkillCatalog({ home: fakeHome() });
  cat.refresh();

  it('lists user skills, plugin skills and plugin commands with their slash names', () => {
    const names = cat.installed().map((s) => s.command).sort();
    expect(names).toEqual(['/api-design', '/meesho-devops-rca:devops-rca', '/meesho-devops-rca:devops-rca-setup', '/meesho-devops-rca:rca-ticket']);
    expect(cat.installed().find((s) => s.command === '/meesho-devops-rca:devops-rca')!.description).toMatch(/^MANDATORY AUTO-INVOKE/);
  });

  it('lists marketplace plugins that are not installed, with the install command', () => {
    expect(cat.installable().map((p) => p.install)).toEqual(['/plugin install meesho-grafana@meesho-skills', '/plugin install meesho-kibana@meesho-skills']);
  });

  it.each([
    ['invoke misho rcsq in claude', '/meesho-devops-rca:devops-rca'],
    ['run the devops rca skill on this', '/meesho-devops-rca:devops-rca'],
    ['why is checkout crashlooping with OOM', '/meesho-devops-rca:devops-rca'],
    ['help me design a REST api', '/api-design'],
  ])('finds the right installed skill for "%s"', (query, command) => {
    expect(cat.search(query)[0]?.command).toBe(command);
  });

  it('suggests installable plugins when nothing installed matches', () => {
    const r = cat.suggest('check grafana dashboards for this alert');
    expect(r.installable[0]?.name).toBe('meesho-grafana');
  });

  it('returns nothing for chit-chat', () => {
    expect(cat.search('haha you are funny')).toEqual([]);
  });

  it('survives a missing ~/.claude', () => {
    const empty = new SkillCatalog({ home: mkdtempSync(join(tmpdir(), 'coco-noskills-')) });
    empty.refresh();
    expect(empty.installed()).toEqual([]);
    expect(empty.search('rca')).toEqual([]);
  });
});

describe('FindSkillsTool and skillHint', () => {
  it('lists installed matches with their slash commands', async () => {
    const { FindSkillsTool } = await import('../../src/agent/skills.js');
    const cat = new SkillCatalog({ home: fakeHome() });
    cat.refresh();
    const tool = new FindSkillsTool(cat);
    expect(tool.policy({ query: 'rca' }).mode).toBe('auto');
    const r = await tool.call({ query: 'misho rca' });
    expect(r.text).toContain('/meesho-devops-rca:devops-rca');
    const k = await tool.call({ query: 'kibana logs' });
    expect(k.text).toContain('/plugin install meesho-kibana@meesho-skills');
  });

  it('hints the gather model only when the user mentions Claude or a skill', async () => {
    const { skillHint } = await import('../../src/agent/skills.js');
    const cat = new SkillCatalog({ home: fakeHome() });
    cat.refresh();
    expect(skillHint(cat, 'Turn up a claude terminal and invoke/Misho RCSQ')).toContain('/meesho-devops-rca:devops-rca');
    expect(skillHint(cat, 'what is on my screen')).toBeUndefined();
  });
});

describe('canonicalizeTask', () => {
  it('corrects a misspelled leading skill command and leaves good ones alone', () => {
    const cat = new SkillCatalog({ home: fakeHome() });
    cat.refresh();
    expect(cat.canonicalizeTask('/mesho-devops-rca:devops-rca checkout 5xx alert')).toBe('/meesho-devops-rca:devops-rca checkout 5xx alert');
    expect(cat.canonicalizeTask('/meesho-devops-rca:devops-rca x')).toBe('/meesho-devops-rca:devops-rca x');
    expect(cat.canonicalizeTask('/totally-unknown:thing x')).toBe('/totally-unknown:thing x');
    expect(cat.canonicalizeTask('explain this error')).toBe('explain this error');
  });
});
