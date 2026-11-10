import { describe, expect, it } from 'vitest';
import { matchRoleAuthoringSeed, shouldCreateRoleDirectly } from '../../../../src/host/services/roleAssets/roleCreationIntent';

describe('shouldCreateRoleDirectly', () => {
  it.each([
    '创建一个日历专家，直接创建',
    '不用再问我问题，按刚才说的创建',
    '这个角色不用确认，直接做吧',
    '/create-role 创建一个专家，名字叫「日历助理」，职责：每天帮我盯日程',
  ])('明确创建意图直接安装：%s', (text) => {
    expect(shouldCreateRoleDirectly(text)).toBe(true);
  });

  it.each([
    '帮我想想要不要建个日程专家',
    '也许以后可以有个日程助手',
    '/create-role 日历助理',
    '/create-role 名字叫「日历助理」',
    '/create-role 职责：每天帮我盯日程',
    '模型建议创建一个日程专家',
    '请不要直接创建，先给我看看',
    '不用直接创建，先出个草稿给我看',
    '不是让你直接创建，先给我看草稿',
    '无需直接创建',
    '不必直接创建',
    '别急着直接创建',
    '直接创建还是先确认？',
    '是否直接创建比较好？',
    '',
  ])('含糊或模型提议仍需确认：%s', (text) => {
    expect(shouldCreateRoleDirectly(text)).toBe(false);
  });
});

describe('matchRoleAuthoringSeed 自然语言建角色', () => {
  it.each([
    '帮我创建一个专家：每天帮我查日历里的日程，并读写我的笔记（备忘录）',
    '帮我创建一个日程管家专家，负责看日历和提醒',
    '帮我创建角色，负责盯竞品',
    '新建角色 日程管家',
    '新建一个盯竞品的研究员角色',
    '帮我建立一个会议纪要助理',
    '给我建立一个助理，管日程',
    '帮我招一个客服助理',
    '直接创建一个日历专家',
  ])('肯定句 → create-role 自然语言种子：%s', (text) => {
    expect(matchRoleAuthoringSeed(text)).toEqual({
      kind: 'natural-language', skillName: 'create-role', text: `/create-role ${text}`,
    });
  });

  it.each([
    '不要创建专家',
    '要不要创建专家',
    '怎么创建专家？',
    '如何新建角色',
    '能不能创建一个助理吗',
    '删除专家',
    '列出我创建的专家',
    '查看我的角色',
    '编辑日程管家角色',
    '帮我写一份周报',
    '',
  ])('否定/疑问/已有专家/无关 → 不匹配：%s', (text) => {
    expect(matchRoleAuthoringSeed(text)).toBeNull();
  });

  it('斜杠种子保持识别', () => {
    expect(matchRoleAuthoringSeed('/create-role 日历')).toMatchObject({ kind: 'slash', skillName: 'create-role' });
    expect(matchRoleAuthoringSeed('/edit-role 日历')).toMatchObject({ kind: 'slash', skillName: 'edit-role' });
  });
});


describe('expert authoring intent must not capture other role meanings', () => {
  it.each([
    '帮我在 postgres 里创建一个只读角色',
    '帮我创建一个 AWS IAM 角色给 Lambda 用',
    '创建一个 PostgreSQL 只读角色',
    '新建一个数据库管理员角色',
    '建立一个 RBAC 角色，权限为只读',
    '创建一个角色，授予数据库只读权限',
    '帮我为游戏创建一个角色',
    '帮我创建一个游戏角色',
    '帮我创建一个小说角色',
    '创建一个战士角色，加入游戏',
    '新建一个游戏法师角色',
    '创建一个小说中的专家',
    '新建一个故事里的助理',
    '新建一个小说里的研究员角色',
    '创建一个故事中的顾问角色',
    '帮我创建一个助理网页 demo',
    '新建一个会议纪要助理网站',
    '建立一个专家介绍页面',
    '创建一个日程助理的网页 demo',
    '帮我创建一个日程助理 web demo',
    '帮我在网页 demo 里创建一个助理',
  ])('非专家任务不成为 authoring seed: %s', (text) => {
    expect(matchRoleAuthoringSeed(text)).toBeNull();
  });

  it.each([
    '创建一个 PostgreSQL 专家，负责优化查询',
    '新建一个 AWS 权限管理助理，帮我审核策略',
    '建立一个小说写作专家，帮我润色章节',
    '帮我创建一个网页开发助理，负责做 demo',
    '创建一个游戏设计师角色，负责分析玩法',
    '帮我创建一个产品经理角色，负责需求分析',
    '创建一个角色',
    '创建一个 PostgreSQL 专家角色，负责优化查询',
    '新建一个日程助理角色，负责看日历',
  ])('明确专家工作请求仍匹配: %s', (text) => {
    expect(matchRoleAuthoringSeed(text)).toMatchObject({ kind: 'natural-language', skillName: 'create-role' });
  });
});
