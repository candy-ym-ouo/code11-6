#!/usr/bin/env node
/**
 * 家人补充 · 重复/冲突检测与并发采纳的端到端验证。
 * 直接打真实 HTTP API；需要 API 在跑（默认 http://127.0.0.1:4000）。
 *
 * 覆盖：
 *  1. 完全重复 / 标点空白差异的重复 / 短回复不误伤 / 与正文重复
 *  2. 两位家人并发采纳两条不同补充：都成功，正文互不覆盖，生成两个版本
 *  3. 并发重复采纳同一条：恰好一个成功，另一个 409 already_decided
 *  4. 已采纳内容不可删除；决策记录（采纳人+版本号）可查
 *  5. 驳回后允许重新提交相同内容
 */
const V1 = `${process.env.API ?? 'http://127.0.0.1:4000'}/api/v1`;

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass += 1; };
const bad = (m) => { console.log(`  ✗ ${m}`); fail += 1; };
const assert = (cond, m) => (cond ? ok(m) : bad(m));

async function api(method, url, { token, body, jar } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(V1 + url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...(jar ? { headers: { ...headers, Cookie: jar.cookie } } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* noop */
  }
  if (jar?.setCookie) {
    const sc = res.headers.getSetCookie?.() ?? [];
    const merged = sc.map((c) => c.split(';')[0]).join('; ');
    jar.cookie = jar.cookie ? `${jar.cookie}; ${merged}` : merged;
  }
  return { status: res.status, json };
}

const register = async (email, name) => {
  const r = await api('POST', '/auth/register', { body: { email, password: 'family2026', displayName: name } });
  if (r.status === 201) return r.json.accessToken;
  const login = await api('POST', '/auth/login', { body: { email, password: 'family2026' } });
  return login.json.accessToken;
};

const run = Date.now();
const ownerToken = await register(process.env.OWNER_EMAIL ?? 'dedup-owner-fixed@example.com', '大姐');
assert(!!ownerToken, '注册/登录发起人');

let r = await api('POST', '/families', { token: ownerToken, body: { name: `查重测试家-${run}` } });
assert(r.status === 201, '创建家庭');
const fid = r.json.family.id;

r = await api('POST', `/families/${fid}/people`, { token: ownerToken, body: { name: '外公' } });
const pid = r.json.person.id;

r = await api('POST', `/families/${fid}/items`, {
  token: ownerToken,
  body: {
    title: '樟木箱',
    category: 'furniture',
    acquiredLabel: '小时候',
    storyHtml: '<p>外公在木器社打的。</p>',
    people: [{ personId: pid, role: 'source' }],
  },
});
assert(r.status === 201, '创建草稿条目');
const iid = r.json.item.id;

r = await api('POST', `/families/${fid}/items/${iid}/publish`, { token: ownerToken });
assert(r.status === 200, '发布条目');

// 邀请第二位家人（contributor，可补充可采纳？contributor 仅自己条目可编辑——
// 用 editor 才能采纳别人的补充）
r = await api('POST', `/families/${fid}/invites`, {
  token: ownerToken,
  body: { role: 'admin', expiresInDays: 1, maxUses: 1 },
});
const inviteCode = r.json.invite.code;
const memberEmail = process.env.MEMBER_EMAIL ?? 'dedup-editor-fixed@example.com';
const memberToken = (await api('POST', '/auth/login', { body: { email: memberEmail, password: 'family2026' } })).json.accessToken;
r = await api('POST', `/invites/${inviteCode}/accept`, { token: memberToken });
assert(r.status === 200, '第二位家人（editor）加入家庭');

console.log('\n== 1. 重复与冲突检测 ==');
const noteA = '箱子是我十岁那年跟着搬家的，木头上还有我刻的印子';
r = await api('POST', `/families/${fid}/items/${iid}/notes`, { token: memberToken, body: { type: 'story', body: noteA } });
assert(r.status === 201, '提交补充 A');
const nidA = r.json.note.id;

// 完全相同
r = await api('POST', `/families/${fid}/items/${iid}/notes`, { token: ownerToken, body: { type: 'story', body: noteA } });
assert(r.status === 409 && r.json.error.details?.reason === 'duplicate_note', '完全重复被拒绝（409 duplicate_note）');
assert(r.json.error.details?.existingNoteId === nidA, '冲突信息指向已存在的补充');

// 仅标点空白差异
r = await api('POST', `/families/${fid}/items/${iid}/notes`, {
  token: ownerToken,
  body: { type: 'story', body: '箱子 是我十岁那年跟着搬家的，木头上还有我刻的印子！' },
});
assert(r.status === 409 && r.json.error.details?.kind === 'exact', '空白/标点差异的重复归一化后仍判重');

// 高度重合（包含）
r = await api('POST', `/families/${fid}/items/${iid}/notes`, {
  token: ownerToken,
  body: { type: 'story', body: '木头上还有我刻的印子，在右下角' },
});
assert(r.status === 409 && r.json.error.details?.kind === 'similar', '高度重合判为 similar');

// 短回复不误伤
r = await api('POST', `/families/${fid}/items/${iid}/notes`, {
  token: ownerToken,
  body: { type: 'comment', body: '是的' },
});
assert(r.status === 201, '短回复「是的」不被误判为重复');
const nidShort = r.json.note.id;

// 内容已在正文（草稿时写入的故事）
r = await api('POST', `/families/${fid}/items/${iid}/notes`, {
  token: ownerToken,
  body: { type: 'story', body: '这件家具是外公在木器社打的东西' },
});
assert(r.status === 409 && r.json.error.details?.reason === 'already_in_story', '与正文重复被拒绝（already_in_story）');

// 不同内容放行
const noteB = '后来六六年的时候差点被劈了当柴烧，外婆拦下了';
r = await api('POST', `/families/${fid}/items/${iid}/notes`, {
  token: ownerToken,
  body: { type: 'story', body: noteB },
});
assert(r.status === 201, '不同内容补充 B 放行');
const nidB = r.json.note.id;

console.log('\n== 2. 两位家人并发采纳两条不同补充 ==');
const [accA, accB] = await Promise.all([
  api('POST', `/families/${fid}/items/${iid}/notes/${nidA}/accept`, { token: ownerToken }),
  api('POST', `/families/${fid}/items/${iid}/notes/${nidB}/accept`, { token: memberToken }),
]);
assert(accA.status === 200 && accB.status === 200, `两个并发采纳都成功（${accA.status}/${accB.status}）`);
assert(
  accA.json.item.storyHtml.includes('刻的印子') && accB.json.item.storyHtml.includes('当柴烧'),
  '后完成的响应中两段补充都在正文（互不覆盖）',
);
const versions = new Set([accA.json.version.version, accB.json.version.version]);
assert(versions.size === 2, `两次采纳生成两个连续版本（${[...versions].sort().join(', ')}）`);

r = await api('GET', `/families/${fid}/items/${iid}`, { token: ownerToken });
const story = r.json.item.storyHtml;
assert(story.includes('刻的印子') && story.includes('当柴烧'), '最终正文同时包含两条已采纳补充');
const acceptedNotes = r.json.item.notes.filter((n) => n.status === 'accepted');
assert(acceptedNotes.length >= 2, `详情中已采纳补充 ${acceptedNotes.length} 条`);
const noteARow = acceptedNotes.find((n) => n.id === nidA);
assert(!!noteARow.versionId && typeof noteARow.versionNumber === 'number', '决策记录关联了版本号');
assert(!!noteARow.decider && noteARow.decider.displayName === '大姐', '决策记录保留了采纳人');

r = await api('GET', `/families/${fid}/items/${iid}/versions`, { token: ownerToken });
const noteVersions = r.json.versions.filter((v) => v.source === 'note');
assert(noteVersions.length >= 2, `版本历史中标注「采纳家人补充」来源的有 ${noteVersions.length} 个`);

console.log('\n== 3. 并发重复采纳同一条 ==');
const noteC = '箱盖内侧有毛笔写的一个「张」字';
r = await api('POST', `/families/${fid}/items/${iid}/notes`, { token: memberToken, body: { type: 'story', body: noteC } });
const nidC = r.json.note.id;
const [again1, again2] = await Promise.all([
  api('POST', `/families/${fid}/items/${iid}/notes/${nidC}/accept`, { token: ownerToken }),
  api('POST', `/families/${fid}/items/${iid}/notes/${nidC}/accept`, { token: memberToken }),
]);
const statuses = [again1.status, again2.status].sort();
assert(statuses[0] === 200 && statuses[1] === 409, `同一条并发采纳恰好一成一冲突（${statuses.join('/')}）`);
const conflictResp = [again1, again2].find((x) => x.status === 409);
assert(conflictResp.json.error.details?.reason === 'already_decided', '重复采纳返回 already_decided');

// 正文里该补充只出现一次
r = await api('GET', `/families/${fid}/items/${iid}`, { token: ownerToken });
const occurrences = r.json.item.storyHtml.split(noteC.slice(0, 10)).length - 1;
assert(occurrences === 1, `补充 C 在正文中只出现一次（实际 ${occurrences}）`);

console.log('\n== 4. 决策不可删除 ==');
r = await api('DELETE', `/families/${fid}/items/${iid}/notes/${nidA}`, { token: ownerToken });
assert(r.status === 409, '已采纳补充：作者也不能删除（409）');
r = await api('DELETE', `/families/${fid}/items/${iid}/notes/${nidShort}`, { token: ownerToken });
assert(r.status === 204, '未采纳的留言：管理员可以删除');

console.log('\n== 5. 驳回后允许重新提交 ==');
const noteD = '这个箱子后来刷过一层清漆';
r = await api('POST', `/families/${fid}/items/${iid}/notes`, { token: memberToken, body: { type: 'correction', body: noteD } });
const nidD = r.json.note.id;
r = await api('POST', `/families/${fid}/items/${iid}/notes/${nidD}/reject`, {
  token: ownerToken,
  body: { reason: '与照片对不上' },
});
assert(r.status === 200, '驳回补充 D');
r = await api('POST', `/families/${fid}/items/${iid}/notes/${nidD}/accept`, { token: ownerToken });
assert(r.status === 409 && r.json.error.details?.reason === 'already_decided', '已驳回不能再采纳');
r = await api('POST', `/families/${fid}/items/${iid}/notes`, { token: ownerToken, body: { type: 'story', body: noteD } });
assert(r.status === 201, '驳回后重新提交相同内容放行');

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
