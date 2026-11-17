// ============================================================================
// Password Reset Modal - Set new password after clicking reset link
// ============================================================================

import React, { useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';
import { KeyRound, CheckCircle, Eye, EyeOff } from 'lucide-react';
import { FormField, Input } from './composites/FormField';
import { Modal } from './primitives/Modal';
import { Button } from './primitives/Button';

export const PasswordResetModal: React.FC = () => {
  const {
    updatePassword,
    isLoading,
    error,
    showPasswordResetModal,
    setShowPasswordResetModal,
    setError,
  } = useAuthStore();
  const { t } = useI18n();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [success, setSuccess] = useState(false);

  if (!showPasswordResetModal) return null;

  const onClose = () => {
    setShowPasswordResetModal(false);
    setPassword('');
    setConfirmPassword('');
    setSuccess(false);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate passwords match
    if (password !== confirmPassword) {
      setError(t.auth.passwordReset.mismatchError);
      return;
    }

    // Validate password strength
    if (password.length < 6) {
      setError(t.auth.passwordReset.tooShortError);
      return;
    }

    const result = await updatePassword(password);
    if (result) {
      setSuccess(true);
    }
  };

  return (
    <Modal
      isOpen={showPasswordResetModal}
      onClose={onClose}
      title={t.auth.passwordReset.title}
      size="md"
    >
      {/* Error message */}
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-badge-danger text-sm">
          {error}
        </div>
      )}

      {success ? (
        /* Success message */
        <div className="py-6 text-center space-y-4">
          <CheckCircle className="w-12 h-12 text-badge-success mx-auto" />
          <div className="space-y-2">
            <p className="text-zinc-200 font-medium">{t.auth.passwordReset.successTitle}</p>
            <p className="text-zinc-400 text-sm">
              {t.auth.passwordReset.successBody}
            </p>
          </div>
          <Button onClick={onClose} className="mt-4 px-6">
            {t.auth.passwordReset.done}
          </Button>
        </div>
      ) : (
        /* Reset form */
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-500/10 border border-badge-info/20 text-badge-info text-sm mb-4">
            <KeyRound className="w-4 h-4 flex-shrink-0" />
            <span>{t.auth.passwordReset.infoBanner}</span>
          </div>

          <FormField label={t.auth.passwordReset.newPassword}>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t.auth.passwordReset.newPasswordPlaceholder}
                required
                minLength={6}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-200"
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>
          </FormField>

          <FormField label={t.auth.passwordReset.confirmPassword}>
            <Input
              type={showPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder={t.auth.passwordReset.confirmPasswordPlaceholder}
              required
              minLength={6}
            />
          </FormField>

          {/* Password strength indicator */}
          {password && (
            <div className="space-y-1">
              <div className="flex gap-1">
                <div
                  className={`h-1 flex-1 rounded ${
                    password.length >= 6 ? 'bg-green-500' : 'bg-zinc-600'
                  }`}
                />
                <div
                  className={`h-1 flex-1 rounded ${
                    password.length >= 8 ? 'bg-green-500' : 'bg-zinc-600'
                  }`}
                />
                <div
                  className={`h-1 flex-1 rounded ${
                    password.length >= 10 && /[A-Z]/.test(password) && /[0-9]/.test(password)
                      ? 'bg-green-500'
                      : 'bg-zinc-600'
                  }`}
                />
              </div>
              <p className="text-xs text-zinc-500">
                {password.length < 6
                  ? t.auth.passwordReset.strengthTooShort
                  : password.length < 8
                  ? t.auth.passwordReset.strengthWeak
                  : password.length < 10 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)
                  ? t.auth.passwordReset.strengthMedium
                  : t.auth.passwordReset.strengthStrong}
              </p>
            </div>
          )}

          <Button
            type="submit"
            fullWidth
            loading={isLoading}
            disabled={password !== confirmPassword || password.length < 6}
            className="min-h-[42px]"
          >
            {t.auth.passwordReset.submit}
          </Button>
        </form>
      )}
    </Modal>
  );
};
