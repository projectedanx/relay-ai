import * as p from '@clack/prompts';

export type ListenMode = 'local' | 'network';
export type ServerStartMode = 'configure' | 'quick';

export async function askServerStartMode(): Promise<ServerStartMode | null> {
  const mode = await p.select<ServerStartMode>({
    message: 'How do you want to start the server?',
    options: [
      { value: 'configure', label: 'Configure & start', hint: 'Providers, discovery masking, listen mode' },
      { value: 'quick', label: 'Start with saved settings', hint: 'Use last server configuration' },
    ],
    initialValue: 'configure',
  });
  if (p.isCancel(mode)) {
    p.cancel('Cancelled.');
    return null;
  }
  return mode;
}

export async function askMaskGatewayIds(initialValue: boolean): Promise<boolean | null> {
  p.note(
    'Claude Desktop and Cowork filter competitor model names in gateway ids. '
    + 'Masking keeps discovery working while display names stay readable.',
    'Needed for Claude Desktop / Cowork',
  );

  const mask = await p.confirm({
    message: 'Mask gateway model ids for discovery?',
    initialValue,
  });
  if (p.isCancel(mask)) {
    p.cancel('Cancelled.');
    return null;
  }
  return Boolean(mask);
}

export async function askFavoritesOnly(initialValue: boolean): Promise<boolean | null> {
  const favoritesOnly = await p.confirm({
    message: 'Expose only favorite models?',
    initialValue,
  });
  if (p.isCancel(favoritesOnly)) {
    p.cancel('Cancelled.');
    return null;
  }
  return Boolean(favoritesOnly);
}

export async function askListenMode(): Promise<ListenMode | null> {
  const mode = await p.select<ListenMode>({
    message: 'Where should the server listen?',
    options: [
      { value: 'local', label: 'Local only', hint: 'Only this computer can use it' },
      { value: 'network', label: 'Network', hint: 'Other computers on your network can use it' },
    ],
    initialValue: 'local',
  });
  if (p.isCancel(mode)) {
    p.cancel('Cancelled.');
    return null;
  }
  return mode;
}

export async function askServerPassword(): Promise<string | null> {
  p.note(
    'Anyone on your network who knows this password can use this server through your OpenCode account.',
    'Network mode warning',
  );

  const password = await p.text({
    message: 'Choose a server password for this run:',
    validate: value => value.trim() ? undefined : 'Password cannot be empty',
  });
  if (p.isCancel(password)) {
    p.cancel('Cancelled.');
    return null;
  }
  return String(password).trim();
}

export async function askUseSavedServerPassword(): Promise<'use-saved' | 'new-password' | null> {
  const choice = await p.select<'use-saved' | 'new-password'>({
    message: 'Use saved server password?',
    options: [
      { value: 'use-saved', label: 'Use saved password' },
      { value: 'new-password', label: 'Enter a new password' },
    ],
    initialValue: 'use-saved',
  });
  if (p.isCancel(choice)) {
    p.cancel('Cancelled.');
    return null;
  }
  return choice;
}

export async function askSaveServerPassword(): Promise<boolean | null> {
  const save = await p.confirm({
    message: 'Save this server password for future server runs?',
    initialValue: false,
  });
  if (p.isCancel(save)) {
    p.cancel('Cancelled.');
    return null;
  }
  return Boolean(save);
}
