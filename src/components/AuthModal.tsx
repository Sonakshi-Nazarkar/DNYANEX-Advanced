import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { DEMO_ACCOUNTS } from '../data/seedData';
import { ShieldCheck, Lock, Mail, AlertCircle, X, UserCheck, KeyRound } from 'lucide-react';

export const AuthModal: React.FC = () => {
  const { isAuthModalOpen, setIsAuthModalOpen, login, addToast } = useApp();
  const [email, setEmail] = useState('elena@campusconnect.edu');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isAuthModalOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError('Please enter both email and password.');
      return;
    }

    try {
      setSubmitting(true);
      const user = await login(email.trim(), password);
      addToast('success', 'Signed In', `Authenticated as ${user.name} (${user.role})`);
      setPassword('');
    } catch (err: any) {
      setError(err.message || 'Invalid credentials');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDemoLogin = async (demoEmail: string, demoPassword: string) => {
    setError(null);
    try {
      setSubmitting(true);
      const user = await login(demoEmail, demoPassword);
      addToast('success', 'Signed In', `Authenticated as ${user.name} (${user.role})`);
    } catch (err: any) {
      setError(err.message || 'Demo login failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white border border-[#E9E2F5] rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-xl text-xs">
        <div className="flex items-center justify-between pb-3 border-b border-[#E9E2F5]">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#8B5CF6] flex items-center justify-center">
              <ShieldCheck className="w-4 h-4 text-white" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-[#171717]">Sign In to DNYANEX Workspace</h2>
              <p className="text-[11px] text-[#71717A]">Role-based access & audit accountability</p>
            </div>
          </div>
          <button
            onClick={() => setIsAuthModalOpen(false)}
            aria-label="Close sign in dialog"
            className="p-1.5 text-[#71717A] hover:text-[#171717] rounded-lg hover:bg-[#FAF8FF] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="p-3 rounded-xl bg-[#FEE2E2] border border-[#FECACA] text-[#DC2626] flex items-center space-x-2 font-medium"
          >
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3.5">
          <div>
            <label className="block text-[#71717A] mb-1 font-mono uppercase text-[10px] font-semibold">
              Work Email
            </label>
            <div className="relative">
              <Mail className="w-3.5 h-3.5 text-[#71717A] absolute left-3 top-2.5" />
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="name@campusconnect.edu"
                className="w-full bg-[#FAF8FF] border border-[#E9E2F5] rounded-lg pl-9 pr-3 py-2 text-[#171717] focus:outline-none focus:border-[#8B5CF6] focus:ring-1 focus:ring-[#8B5CF6]"
              />
            </div>
          </div>

          <div>
            <label className="block text-[#71717A] mb-1 font-mono uppercase text-[10px] font-semibold">
              Password
            </label>
            <div className="relative">
              <Lock className="w-3.5 h-3.5 text-[#71717A] absolute left-3 top-2.5" />
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter password (demo: dnyanex-demo)"
                className="w-full bg-[#FAF8FF] border border-[#E9E2F5] rounded-lg pl-9 pr-3 py-2 text-[#171717] focus:outline-none focus:border-[#8B5CF6] focus:ring-1 focus:ring-[#8B5CF6]"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full flex items-center justify-center space-x-2 bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:opacity-50 text-white font-bold py-2.5 rounded-xl transition-all cursor-pointer shadow-xs"
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span>{submitting ? 'Authenticating...' : 'Sign In with Credentials'}</span>
          </button>
        </form>

        <div className="pt-3 border-t border-[#E9E2F5] space-y-2.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-mono uppercase font-semibold text-[#71717A]">
              Quick Role Demo Accounts
            </span>
            <span className="font-mono text-[#8B5CF6] bg-[#F5F0FF] px-2 py-0.5 rounded border border-[#E9E2F5]">
              pw: dnyanex-demo
            </span>
          </div>

          <div className="grid grid-cols-1 gap-2">
            {DEMO_ACCOUNTS.map(acc => (
              <button
                key={acc.id}
                type="button"
                disabled={submitting}
                onClick={() => handleDemoLogin(acc.email, acc.password)}
                className="flex items-center justify-between p-2.5 rounded-xl bg-[#FAF8FF] hover:bg-[#F5F0FF] border border-[#E9E2F5] hover:border-[#8B5CF6] transition-all text-left cursor-pointer"
              >
                <div className="flex items-center space-x-2.5">
                  <UserCheck className="w-4 h-4 text-[#8B5CF6] shrink-0" />
                  <div>
                    <div className="font-bold text-[#171717]">{acc.name}</div>
                    <div className="text-[10px] text-[#71717A] font-mono">{acc.email}</div>
                  </div>
                </div>
                <span className="font-mono text-[10px] font-bold px-2 py-0.5 rounded-md bg-white border border-[#E9E2F5] text-[#8B5CF6]">
                  {acc.role}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
