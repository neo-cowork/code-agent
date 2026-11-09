import React, { type RefObject } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { FormField, Input, type InputProps } from '../../../composites/FormField';
import type {
  ChannelAccountConfig,
  ChannelPrivacyMode,
  ChannelType,
  FeishuChannelConfig,
  LarkChannelConfig,
} from '@shared/contract/channel';

export type ChannelRequiredField = 'name' | 'appId' | 'appCredential' | 'botToken';
export type ChannelFormErrors = Partial<Record<ChannelRequiredField, string>>;

interface ChannelFormValues {
  name: string;
  type: ChannelType;
  appId: string;
  appCredential: string;
  botToken: string;
}

interface ChannelConfigValues {
  type: ChannelType;
  apiPort: string;
  httpCredential: string;
  enableCors: boolean;
  appId: string;
  appCredential: string;
  encryptKey: string;
  verificationToken: string;
  webhookPort: string;
  useWebSocket: boolean;
  outboundTargets: string;
  larkLikeConfig?: FeishuChannelConfig | LarkChannelConfig;
  botToken: string;
  tgProxyUrl: string;
  tgFallbackProxy: string;
  tgAllowedUserIds: string;
  tgGroupAccessMode: 'allowlist' | 'all_members';
  privacyMode: ChannelPrivacyMode;
}

interface ChannelRequiredFieldCopy {
  name: string;
  appId: string;
  appCredential: string;
  botToken: string;
}

interface ChannelRequiredFieldProps {
  label: string;
  error?: string;
  id: string;
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: InputProps['type'];
  showSensitiveValue?: boolean;
  onToggleSensitiveValue?: () => void;
  showSensitiveValueLabel?: string;
  hideSensitiveValueLabel?: string;
}

export const ChannelRequiredField: React.FC<ChannelRequiredFieldProps> = ({
  label,
  error,
  id,
  inputRef,
  value,
  onChange,
  placeholder,
  type = 'text',
  showSensitiveValue = false,
  onToggleSensitiveValue,
  showSensitiveValueLabel,
  hideSensitiveValueLabel,
}) => {
  const field = (
    <FormField label={label} required error={error} htmlFor={id}>
      <Input
        ref={inputRef}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="bg-zinc-700 border-zinc-700 pr-10 text-zinc-200 focus:border-badge-accent"
        placeholder={placeholder}
      />
    </FormField>
  );

  if (!onToggleSensitiveValue) return field;

  return (
    <div className="relative">
      {field}
      <button
        type="button"
        onClick={onToggleSensitiveValue}
        className="absolute right-3 top-8 text-zinc-500 hover:text-zinc-400"
        aria-label={showSensitiveValue ? hideSensitiveValueLabel : showSensitiveValueLabel}
      >
        {showSensitiveValue ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
      </button>
    </div>
  );
};

export function clearChannelFormError(
  current: ChannelFormErrors,
  field: ChannelRequiredField,
): ChannelFormErrors {
  if (!current[field]) return current;
  const next = { ...current };
  delete next[field];
  return next;
}

export function validateChannelRequiredFields(
  values: ChannelFormValues,
  copy: ChannelRequiredFieldCopy,
): ChannelFormErrors {
  const errors: ChannelFormErrors = {};

  if (!values.name.trim()) errors.name = copy.name;

  if (values.type === 'feishu' || values.type === 'lark') {
    if (!values.appId.trim()) errors.appId = copy.appId;
    if (!values.appCredential.trim()) errors.appCredential = copy.appCredential;
  }

  if (values.type === 'telegram' && !values.botToken.trim()) {
    errors.botToken = copy.botToken;
  }

  return errors;
}

export function buildChannelConfig(values: ChannelConfigValues): ChannelAccountConfig | undefined {
  const { type, privacyMode } = values;

  if (type === 'http-api') {
    return {
      type,
      port: parseInt(values.apiPort) || 8080,
      apiKey: values.httpCredential || crypto.randomUUID().replace(/-/g, ''),
      enableCors: values.enableCors,
      privacyMode,
    };
  }

  if (type === 'feishu' || type === 'lark') {
    return {
      type,
      appId: values.appId,
      appSecret: values.appCredential,
      encryptKey: values.encryptKey || undefined,
      verificationToken: values.verificationToken || undefined,
      useWebSocket: values.useWebSocket,
      webhookPort: parseInt(values.webhookPort) || 3200,
      outboundAllowlist: values.outboundTargets
        .split(/[,\n]/)
        .map((target) => target.trim())
        .filter(Boolean),
      inboundAllowlist: values.larkLikeConfig?.inboundAllowlist,
      ownerOpenId: values.larkLikeConfig?.ownerOpenId,
      privacyMode,
    };
  }

  if (type === 'telegram') {
    const userIds = values.tgAllowedUserIds
      .split(',')
      .map((value) => parseInt(value.trim()))
      .filter((value) => !isNaN(value));
    return {
      type,
      botToken: values.botToken,
      proxyUrl: values.tgProxyUrl || undefined,
      fallbackProxyUrl: values.tgFallbackProxy || undefined,
      allowedUserIds: userIds.length > 0 ? userIds : undefined,
      groupAccessMode: values.tgGroupAccessMode,
      privacyMode,
    };
  }

  return undefined;
}
