// 归档项目显示名：任务只存 id，确认卡要给人看名字。listProjects 读不到/项目已删
// 都返回 undefined，由 builder 落兜底文案，绝不把 id 当名字。
import { useEffect, useState } from 'react';
import { listProjects } from '../../../services/projectClient';

export function useArchiveProjectName(projectId: string | undefined): string | undefined {
  const id = projectId?.trim() || '';
  const [name, setName] = useState<string | undefined>(undefined);
  useEffect(() => {
    let active = true;
    setName(undefined);
    if (!id) return;
    listProjects()
      .then((projects) => {
        if (active) setName(projects.find((project) => project.id === id)?.name);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [id]);
  return name;
}
