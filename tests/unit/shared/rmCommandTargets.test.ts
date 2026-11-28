import { describe, expect, it } from 'vitest';
import { isDeleteShellCommand, parseRmTargets } from '../../../src/shared/rmCommandTargets';

describe('parseRmTargets', () => {
  it('单目标：exact 且非递归', () => {
    expect(parseRmTargets('rm ./a.log')).toEqual({
      targets: ['./a.log'],
      exact: true,
      recursive: false,
    });
  });

  it('两个目标', () => {
    expect(parseRmTargets('rm -rf ./a.log ./b.log')).toEqual({
      targets: ['./a.log', './b.log'],
      exact: true,
      recursive: true,
    });
  });

  it('三个目标（-- 分隔符后的都是目标）', () => {
    expect(parseRmTargets('rm -- "./a.log" "./b.log" "./c.log"')).toEqual({
      targets: ['./a.log', './b.log', './c.log'],
      exact: true,
      recursive: false,
    });
  });

  it('双引号与单引号目标去引号，引号内空格不断 token', () => {
    expect(parseRmTargets('rm "my file.log" \'other.log\'')).toEqual({
      targets: ['my file.log', 'other.log'],
      exact: true,
      recursive: false,
    });
  });

  it('引号内的 ; | & 不切段', () => {
    expect(parseRmTargets('rm "a;b|c&d.log"')).toEqual({
      targets: ['a;b|c&d.log'],
      exact: true,
      recursive: false,
    });
  });

  it('cd x && rm a b：只取 rm 段的目标', () => {
    expect(parseRmTargets('cd /tmp/logs && rm a.log b.log')).toEqual({
      targets: ['a.log', 'b.log'],
      exact: true,
      recursive: false,
    });
  });

  it('多段 rm（; 与 &&）目标合并、recursive 取或', () => {
    expect(parseRmTargets('rm a.log; cd x && rm -r b.log')).toEqual({
      targets: ['a.log', 'b.log'],
      exact: true,
      recursive: true,
    });
  });

  it('sudo rm 也解析目标', () => {
    expect(parseRmTargets('sudo rm a.log b.log')).toEqual({
      targets: ['a.log', 'b.log'],
      exact: true,
      recursive: false,
    });
  });

  it('rm -- -开头的文件名按目标处理', () => {
    expect(parseRmTargets('rm -- -weird-name.log')).toEqual({
      targets: ['-weird-name.log'],
      exact: true,
      recursive: false,
    });
  });

  it('短簇/长选项都识别递归', () => {
    expect(parseRmTargets('rm -fr x.log').recursive).toBe(true);
    expect(parseRmTargets('rm --recursive x.log').recursive).toBe(true);
    expect(parseRmTargets('rm -f x.log').recursive).toBe(false);
    expect(parseRmTargets('rm --force x.log').recursive).toBe(false);
  });

  it('通配符目标：exact=false（目标仍保留用于展示）', () => {
    expect(parseRmTargets('rm *.log')).toEqual({
      targets: ['*.log'],
      exact: false,
      recursive: false,
    });
  });

  it('变量展开：exact=false', () => {
    expect(parseRmTargets('rm $FILES')).toEqual({
      targets: ['$FILES'],
      exact: false,
      recursive: false,
    });
    expect(parseRmTargets('rm ${DIR}/a.log').exact).toBe(false);
  });

  it('命令替换 $( 与反引号：exact=false', () => {
    expect(parseRmTargets('rm $(ls *.log)').exact).toBe(false);
    expect(parseRmTargets('rm `ls *.log`').exact).toBe(false);
  });

  it('目标里的 [ 与 { 通配：exact=false', () => {
    expect(parseRmTargets('rm [ab].txt').exact).toBe(false);
    expect(parseRmTargets('rm file{1,2}.txt').exact).toBe(false);
  });

  it('find -delete：无 rm 目标，不写数字的依据', () => {
    expect(parseRmTargets("find . -name '*.log' -delete")).toEqual({
      targets: [],
      exact: true,
      recursive: false,
    });
  });

  it('ls | xargs rm：rm 被管道喂入，exact=false 且不猜目标', () => {
    expect(parseRmTargets('ls | xargs rm')).toEqual({
      targets: [],
      exact: false,
      recursive: false,
    });
  });

  it('管道直接接 rm：exact=false', () => {
    expect(parseRmTargets('echo x | rm a.log').exact).toBe(false);
  });

  it('find -exec rm：exact=false', () => {
    expect(parseRmTargets("find . -name '*.log' -exec rm {} \\;").exact).toBe(false);
  });

  it('重定向不进目标清单', () => {
    expect(parseRmTargets('rm a.log b.log > cleanup.log 2>&1')).toEqual({
      targets: ['a.log', 'b.log'],
      exact: true,
      recursive: false,
    });
    expect(parseRmTargets('rm a.log 2> /dev/null').targets).toEqual(['a.log']);
    expect(parseRmTargets('rm -rf ./d1 ./d2 >> ./count.log').targets).toEqual(['./d1', './d2']);
  });

  it('空命令与无 rm 命令：空目标', () => {
    expect(parseRmTargets('').targets).toEqual([]);
    expect(parseRmTargets('ls -la').targets).toEqual([]);
    expect(parseRmTargets('echo rm a.log').targets).toEqual([]);
  });

  it('rm && rmdir 链式删除：点名全部目标，emptyDirTargets 记录空目录数', () => {
    expect(parseRmTargets('rm -v key-points.md && rmdir -v temp')).toEqual({
      targets: ['key-points.md', 'temp'],
      exact: true,
      recursive: false,
      emptyDirTargets: 1,
    });
    expect(parseRmTargets('unlink old.txt')).toEqual({
      targets: ['old.txt'],
      exact: true,
      recursive: false,
    });
  });

  it('isDeleteShellCommand 只命中真实删除段，不误判子命令或只读回显', () => {
    expect(isDeleteShellCommand('rm a.log')).toBe(true);
    expect(isDeleteShellCommand('rm -v key-points.md && rmdir -v temp')).toBe(true);
    expect(isDeleteShellCommand('unlink old.txt')).toBe(true);
    expect(isDeleteShellCommand('ls | xargs rm')).toBe(true);
    expect(isDeleteShellCommand('git rm a.log b.log')).toBe(false);
    expect(isDeleteShellCommand('docker rm web-1')).toBe(false);
    expect(isDeleteShellCommand('echo rm -v a.md && ls temp')).toBe(false);
    expect(isDeleteShellCommand('cat a.log')).toBe(false);
  });
});
