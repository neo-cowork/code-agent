export const envAssistZh = {
  sentence: {
    calendar: '要看你的日程，需要你允许 Neo 访问「日历」。',
    mail: '要读写你的邮件，需要你允许 Neo 控制「邮件」。',
    reminders: '要查看和创建提醒，需要你允许 Neo 控制「提醒事项」。',
    screen: '要查看你的屏幕，需要你允许 Neo 录制屏幕。',
    computer: '要操作你的电脑，需要你允许 Neo 使用辅助功能。',
    helperScreen: '要查看你的屏幕，需要你允许 Neo 的电脑控制助手录制屏幕。',
    helperComputer: '要操作你的电脑，需要你允许 Neo 的电脑控制助手使用辅助功能。',
  },
  allow: { calendar: '允许访问日历', mail: '允许访问邮件', reminders: '允许访问提醒事项', screen: '允许查看屏幕', computer: '允许操作电脑', helperScreen: '允许查看屏幕', helperComputer: '允许操作电脑' },
  done: { calendar: '已允许 Neo 访问「日历」。', mail: '已允许 Neo 控制「邮件」。', reminders: '已允许 Neo 控制「提醒事项」。', screen: '已允许 Neo 录制屏幕。', computer: '已允许 Neo 使用辅助功能。', helperScreen: '已允许电脑控制助手录制屏幕。', helperComputer: '已允许电脑控制助手使用辅助功能。' },
  autoResume: '允许后会自动接着做。',
  target: { calendar: '日历', mail: '邮件', reminders: '提醒事项', screen: '屏幕', computer: '电脑', helperScreen: '屏幕', helperComputer: '电脑' },
};

export const envAssistEn: typeof envAssistZh = {
  sentence: {
    calendar: 'To read your schedule, Neo needs your OK to access Calendar.',
    mail: 'To read and write your email, Neo needs your OK to control Mail.',
    reminders: 'To read and create reminders, Neo needs your OK to control Reminders.',
    screen: 'To see your screen, Neo needs your OK to record it.',
    computer: 'To use your computer, Neo needs your OK to use accessibility features.',
    helperScreen: "To see your screen, Neo's computer-control helper needs your OK to record it.",
    helperComputer: "To use your computer, Neo's computer-control helper needs your OK to use accessibility features.",
  },
  allow: { calendar: 'Allow Calendar', mail: 'Allow Mail', reminders: 'Allow Reminders', screen: 'Allow screen recording', computer: 'Allow accessibility', helperScreen: 'Allow screen recording', helperComputer: 'Allow accessibility' },
  done: { calendar: 'Neo can now access Calendar.', mail: 'Neo can now control Mail.', reminders: 'Neo can now control Reminders.', screen: 'Neo can now record your screen.', computer: 'Neo can now use accessibility features.', helperScreen: 'The computer-control helper can now record your screen.', helperComputer: 'The computer-control helper can now use accessibility features.' },
  autoResume: 'Neo picks the task back up once you allow it.',
  target: { calendar: 'Calendar', mail: 'Mail', reminders: 'Reminders', screen: 'Screen', computer: 'Computer', helperScreen: 'Screen', helperComputer: 'Computer' },
};
