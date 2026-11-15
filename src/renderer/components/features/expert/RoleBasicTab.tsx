import React from 'react';

export const RoleBasicTab: React.FC<{ action: React.ReactNode; editor: React.ReactNode; notice: React.ReactNode; summary?: React.ReactNode }> = ({ action, editor, notice, summary }) => (
  <section data-testid="role-detail-basic-tab" className="space-y-4">
    {summary}
    <div className="flex justify-end">{action}</div>
    {editor}
    {notice}
  </section>
);
