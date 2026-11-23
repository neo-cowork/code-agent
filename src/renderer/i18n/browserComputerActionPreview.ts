import type { Language } from './index';

type Messages = {
  readOnly: string;
  managedBrowser: string;
  backgroundInput: string;
  backgroundAccessibility: string;
  foregroundConfirmation: string;
  launch: string;
  close: string;
  newTab: string;
  closeTab: string;
  switchTab: string;
  navigate: string;
  back: string;
  forward: string;
  reload: string;
  viewport: string;
  browserClick: string;
  clickText: string;
  pressKey: string;
  browserScroll: string;
  screenshot: string;
  getContent: string;
  getBrowserElements: string;
  getDomSnapshot: string;
  getA11ySnapshot: string;
  getWorkbenchState: string;
  getAccountState: string;
  exportStorageState: string;
  importStorageState: string;
  waitForDownload: string;
  uploadFile: string;
  wait: string;
  fillForm: string;
  getLogs: string;
  keepResultPage: string;
  waitForUser: string;
  getComputerState: string;
  observeApp: string;
  observeFrontWindow: string;
  getAxElements: string;
  getWindows: string;
  diagnoseApp: string;
  moveMouse: string;
  desktopKey: string;
  desktopScroll: string;
  drag: string;
  locateElement: string;
  locateText: string;
  locateRole: string;
  smartClick: string;
  smartHover: string;
  getInteractiveElements: string;
  accountState: string;
  downloadDone: string;
  uploadSelected: string;
  screenshotSaved: string;
  domSnapshotRead: string;
  a11ySnapshotRead: string;
  workbenchStateRead: string;
  accountStateRead: string;
  storageStateExported: string;
  storageStateImported: string;
  contentRead: string;
  logsRead: string;
  browserType: (text: string) => string;
  desktopType: (text: string) => string;
  smartType: (text: string) => string;
  browserAction: (action: string) => string;
  computerAction: (action: string) => string;
  backgroundWindowClick: (action: 'click' | 'doubleClick' | 'rightClick') => string;
  backgroundElementClick: (action: 'click' | 'doubleClick' | 'rightClick') => string;
  coordinateClick: (action: 'click' | 'doubleClick' | 'rightClick') => string;
  charCount: (count: number) => string;
  textFallback: string;
  fullPage: string;
  withScreenshot: string;
  fieldCount: (count: number) => string;
  retryHint: (hint: string) => string;
  elementNotFound: (summary: string, error: string) => string;
  screenshotSavedAs: (fileName: string) => string;
  domSnapshotCounts: (headings: number, interactive: number) => string;
};

const desktopClickVerb = {
  click: 'Clicked',
  doubleClick: 'Double-clicked',
  rightClick: 'Right-clicked',
};

const zhClickVerb = {
  click: '点击',
  doubleClick: '双击',
  rightClick: '右键点击',
};

const messages: Record<Language, Messages> = {
  zh: {
    readOnly: '只读',
    managedBrowser: '托管浏览器动作',
    backgroundInput: '后台输入',
    backgroundAccessibility: '后台无障碍',
    foregroundConfirmation: '前台需确认',
    launch: '启动托管浏览器',
    close: '关闭托管浏览器',
    newTab: '打开新标签页',
    closeTab: '关闭标签页',
    switchTab: '切换标签页',
    navigate: '导航到页面',
    back: '浏览器后退',
    forward: '浏览器前进',
    reload: '刷新页面',
    viewport: '设置视口',
    browserClick: '点击页面元素',
    clickText: '点击页面文本',
    pressKey: '按键',
    browserScroll: '滚动页面',
    screenshot: '截取页面截图',
    getContent: '读取页面内容',
    getBrowserElements: '读取页面元素',
    getDomSnapshot: '读取页面结构',
    getA11ySnapshot: '读取页面无障碍信息',
    getWorkbenchState: '读取浏览器状态',
    getAccountState: '读取账号态摘要',
    exportStorageState: '导出登录状态',
    importStorageState: '导入登录状态',
    waitForDownload: '等待下载完成',
    uploadFile: '上传文件',
    wait: '等待页面状态',
    fillForm: '填写表单',
    getLogs: '读取浏览器日志',
    keepResultPage: '保留结果页给用户',
    waitForUser: '等你来处理',
    getComputerState: '读取电脑操作状态',
    observeApp: '观察目标应用窗口',
    observeFrontWindow: '观察前台窗口',
    getAxElements: '读取后台无障碍元素',
    getWindows: '读取窗口候选',
    diagnoseApp: '诊断目标应用',
    moveMouse: '移动鼠标',
    desktopKey: '桌面按键',
    desktopScroll: '桌面滚动',
    drag: '桌面拖拽',
    locateElement: '定位页面元素',
    locateText: '定位页面文本',
    locateRole: '定位页面角色',
    smartClick: '智能点击浏览器元素',
    smartHover: '智能悬停浏览器元素',
    getInteractiveElements: '读取可交互元素',
    accountState: '账号态',
    downloadDone: '下载完成',
    uploadSelected: '上传文件已选择',
    screenshotSaved: '截图已保存',
    domSnapshotRead: '页面结构已读取',
    a11ySnapshotRead: '页面无障碍信息已读取',
    workbenchStateRead: '浏览器状态已读取',
    accountStateRead: '账号态摘要已读取',
    storageStateExported: '登录状态已导出',
    storageStateImported: '登录状态已导入',
    contentRead: '页面内容已读取',
    logsRead: '浏览器日志已读取',
    browserType: text => `输入 ${text}`,
    desktopType: text => `桌面输入 ${text}`,
    smartType: text => `智能输入 ${text}`,
    browserAction: action => `浏览器动作: ${action}`,
    computerAction: action => `电脑动作: ${action}`,
    backgroundWindowClick: action => `${zhClickVerb[action]}后台窗口`,
    backgroundElementClick: action => `${zhClickVerb[action]}后台元素`,
    coordinateClick: action => `${zhClickVerb[action]}坐标`,
    charCount: count => `${count} 个字符`,
    textFallback: '文本',
    fullPage: '整页',
    withScreenshot: '附截图',
    fieldCount: count => `${count} 个字段`,
    retryHint: hint => `建议：${hint}`,
    elementNotFound: (summary, error) => `${summary} 没执行成功：目标元素未找到。${error ? ` ${error}` : ''}`,
    screenshotSavedAs: fileName => `截图已保存: ${fileName}`,
    domSnapshotCounts: (headings, interactive) => `页面结构：${headings} 个标题 · ${interactive} 个可点元素`,
  },
  en: {
    readOnly: 'Read-only',
    managedBrowser: 'Managed browser action',
    backgroundInput: 'Background input',
    backgroundAccessibility: 'Background accessibility',
    foregroundConfirmation: 'Needs confirmation in front',
    launch: 'Started the managed browser',
    close: 'Closed the managed browser',
    newTab: 'Opened a new tab',
    closeTab: 'Closed a tab',
    switchTab: 'Switched tabs',
    navigate: 'Opened a page',
    back: 'Went back a page',
    forward: 'Went forward a page',
    reload: 'Reloaded the page',
    viewport: 'Set the window size',
    browserClick: 'Clicked a page element',
    clickText: 'Clicked page text',
    pressKey: 'Pressed a key',
    browserScroll: 'Scrolled the page',
    screenshot: 'Took a page screenshot',
    getContent: 'Read the page content',
    getBrowserElements: 'Read the page elements',
    getDomSnapshot: 'Read the page structure',
    getA11ySnapshot: 'Read the page\'s accessibility info',
    getWorkbenchState: 'Read the browser\'s status',
    getAccountState: 'Checked the saved login state',
    exportStorageState: 'Exported saved login state',
    importStorageState: 'Imported saved login state',
    waitForDownload: 'Waited for the download to finish',
    uploadFile: 'Uploaded a file',
    wait: 'Waited for the page',
    fillForm: 'Filled in a form',
    getLogs: 'Read the browser logs',
    keepResultPage: 'Kept the results page open',
    waitForUser: 'Waiting for you to continue',
    getComputerState: 'Checked the desktop controls',
    observeApp: 'Looked at the target app',
    observeFrontWindow: 'Looked at the front window',
    getAxElements: 'Read accessibility info in the background',
    getWindows: 'Listed window candidates',
    diagnoseApp: 'Checked the target app',
    moveMouse: 'Moved the pointer',
    desktopKey: 'Pressed a desktop key',
    desktopScroll: 'Scrolled the desktop',
    drag: 'Dragged the pointer',
    locateElement: 'Located a page element',
    locateText: 'Located page text',
    locateRole: 'Located a page element by its role',
    smartClick: 'Clicked a browser element',
    smartHover: 'Hovered over a browser element',
    getInteractiveElements: 'Read the interactive elements',
    accountState: 'Saved login state',
    downloadDone: 'Download complete',
    uploadSelected: 'Selected a file to upload',
    screenshotSaved: 'Screenshot saved',
    domSnapshotRead: 'Page structure read',
    a11ySnapshotRead: 'Page accessibility info read',
    workbenchStateRead: 'Browser status read',
    accountStateRead: 'Saved login state checked',
    storageStateExported: 'Saved login state exported',
    storageStateImported: 'Saved login state imported',
    contentRead: 'Page content read',
    logsRead: 'Browser logs read',
    browserType: text => `Typed ${text}`,
    desktopType: text => `Typed on the desktop ${text}`,
    smartType: text => `Typed in the browser ${text}`,
    browserAction: action => `Browser action: ${action}`,
    computerAction: action => `Computer action: ${action}`,
    backgroundWindowClick: action => `${desktopClickVerb[action]} a background window`,
    backgroundElementClick: action => `${desktopClickVerb[action]} a background element`,
    coordinateClick: action => `${desktopClickVerb[action]} a screen position`,
    charCount: count => `${count} chars`,
    textFallback: 'text',
    fullPage: 'full page',
    withScreenshot: 'with screenshot',
    fieldCount: count => `${count} fields`,
    retryHint: hint => `Suggestion: ${hint}`,
    elementNotFound: (summary, error) => `${summary} failed: Target element not found.${error ? ` ${error}` : ''}`,
    screenshotSavedAs: fileName => `Screenshot saved: ${fileName}`,
    domSnapshotCounts: (headings, interactive) => `Page structure: ${headings} headings · ${interactive} clickable elements`,
  },
};

export function getBrowserComputerActionPreviewMessages(locale: Language): Messages {
  return messages[locale];
}
