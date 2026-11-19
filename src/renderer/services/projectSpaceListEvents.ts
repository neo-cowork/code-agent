// 协作空间列表变更。侧栏空空间分组订阅它，项目列表页自己的刷新不经过这里。

export type ProjectSpaceListChange = 'created' | 'promoted' | 'renamed' | 'status' | 'deleted';

type ProjectSpaceListListener = (change: ProjectSpaceListChange) => void;

const listeners = new Set<ProjectSpaceListListener>();

export function subscribeProjectSpaceList(listener: ProjectSpaceListListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyProjectSpaceList(change: ProjectSpaceListChange): void {
  for (const listener of listeners) {
    listener(change);
  }
}
