import { CLI_CONNECTOR_DESCRIPTORS } from '../constants/cliConnectorDescriptors';

const messages = {
  zh: {
    title: (name: string) => `${name}已退出登录`,
    body: '今天的定时任务没有运行。重新连接后，任务会按计划继续运行。',
  },
  en: {
    title: (name: string) => `${name} signed out`,
    body: "Today's scheduled task didn't run. Reconnect to resume future runs.",
  },
};

export function getCronConnectorLostNotificationText(
  locale: keyof typeof messages,
  connectorId: string,
): { title: string; body: string } | undefined {
  const connector = CLI_CONNECTOR_DESCRIPTORS.find(({ id }) => id === connectorId);
  const name = locale === 'en' ? connector?.displayNameEn : connector?.displayName;
  if (!name) return undefined;
  const copy = messages[locale];
  return { title: copy.title(name), body: copy.body };
}
