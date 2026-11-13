// execute_goal 暴露面的路由探针：shared 层不能 import host，由启动时注入。
// 范式同 decideAvailability：解析路由，抛错交给 shared 侧按「不可用」处理并 warn 一次。
import { registerBrowserJevRouteProbe } from '../../../../shared/constants/jevQuestions';
import { resolveJevRoute } from '../../../model/providers/typesafeProvider';

export function installBrowserJevRouteProbe(): void {
  registerBrowserJevRouteProbe(() => resolveJevRoute() !== null);
}
