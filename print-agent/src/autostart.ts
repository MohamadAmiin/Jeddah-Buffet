// START AT SIGN-IN, FOR THE SIGNED-IN USER (tasks/print-agent-installer T-07).
//
// The agent must be running whenever the till sells, and the person installing
// it may not be an administrator. So it registers itself for the CURRENT USER,
// with the tool each OS ships, and installs nothing:
//
//   Windows  a Task Scheduler task "matcami print agent", registered from XML
//            (`schtasks /Create /XML`) — schedule names are localized on
//            non-English Windows, which is why the XML route exists. Every
//            setting is written out: Task Scheduler's own defaults stop a task
//            after 72 hours and when a laptop leaves mains power (RESEARCH.md),
//            which on a till that never signs out means printing stops on day
//            four. The task runs `run --detach`: that launcher starts a
//            console-less supervisor and exits, so the till shows at most a
//            sub-second console flash at sign-in (decision 3 of the plan).
//   Linux    a `systemd --user` unit, restarted on failure.
//   macOS    a LaunchAgent, restarted on a crash and left down after a clean quit.
//
// An agent that finds its port taken exits 0 ("already running", main.ts), so
// none of the three supervisors loops on a second copy.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, win32 } from 'node:path';

export const TASK_NAME = 'matcami print agent';
export const UNIT_NAME = 'matcami-print-agent';
export const LAUNCHD_LABEL = 'com.matcami.print-agent';

export type ExecResult = { status: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;

export type AutostartResult =
	{ ok: true } | { ok: false; step: string; stderr: string } | { ok: false; manual: string[] };

/** What registering touches, injectable so the tests write to a temp home and record commands. */
export type AutostartIo = {
	exec: Exec;
	env: Record<string, string | undefined>;
	home: string;
	uid: number;
	write: (path: string, data: string | Buffer) => void;
	remove: (path: string) => void;
};

const realExec: Exec = (cmd, args) => {
	const result = spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8' });
	return {
		status: result.status ?? -1,
		stdout: result.stdout ?? '',
		stderr: result.stderr || (result.error ? result.error.message : '')
	};
};

export const realIo = (): AutostartIo => ({
	exec: realExec,
	env: process.env,
	home: homedir(),
	uid: process.getuid?.() ?? 0,
	write: (path, data) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, data);
	},
	remove: (path) => rmSync(path, { force: true })
});

const xml = (value: string) =>
	value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');

/** The Windows logon task. Every setting is explicit; see the file header for why. */
export function windowsTaskXml(args: { exePath: string; userId: string }): string {
	const user = xml(args.userId);
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>matcami print agent: receipts, kitchen tickets and the cash drawer for the till on this PC.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>${xml(args.exePath)}</Command><Arguments>run --detach</Arguments></Exec>
  </Actions>
</Task>
`;
}

/** systemd ExecStart quoting: inside double quotes, \ and " are escaped; % and $ are doubled. */
const systemdQuote = (value: string) =>
	'"' +
	value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$') +
	'"';

export function systemdUserUnit(args: { exePath: string }): string {
	return `[Unit]
Description=matcami print agent (receipts, kitchen tickets, cash drawer)

[Service]
ExecStart=${systemdQuote(args.exePath)} run
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(args: { exePath: string; logPath: string }): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCHD_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(args.exePath)}</string>
		<string>run</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>StandardOutPath</key>
	<string>${xml(args.logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(args.logPath)}</string>
</dict>
</plist>
`;
}

function windowsUser(io: AutostartIo): string {
	const name = io.env.USERNAME || userInfo().username;
	return io.env.USERDOMAIN ? `${io.env.USERDOMAIN}\\${name}` : name;
}
const unitPath = (io: AutostartIo) =>
	join(
		io.env.XDG_CONFIG_HOME || join(io.home, '.config'),
		'systemd',
		'user',
		`${UNIT_NAME}.service`
	);
const plistPath = (io: AutostartIo) =>
	join(io.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

function step(io: AutostartIo, label: string, cmd: string, args: string[]): AutostartResult | null {
	const result = io.exec(cmd, args);
	return result.status === 0 ? null : { ok: false, step: label, stderr: result.stderr.trim() };
}

/** Register the agent to start at sign-in for this user, and start it now. */
export function registerAutostart(
	platform: string,
	args: { exePath: string; dir: string },
	io: AutostartIo = realIo()
): AutostartResult {
	if (platform === 'win32') {
		const xmlPath = win32.join(args.dir, 'task.xml');
		// UTF-16LE with a byte-order mark: what schtasks /XML reads reliably.
		io.write(
			xmlPath,
			Buffer.from(
				'\ufeff' + windowsTaskXml({ exePath: args.exePath, userId: windowsUser(io) }),
				'utf16le'
			)
		);
		return (
			step(io, 'schtasks /Create', 'schtasks', [
				'/Create',
				'/TN',
				TASK_NAME,
				'/XML',
				xmlPath,
				'/F'
			]) ??
			step(io, 'schtasks /Run', 'schtasks', ['/Run', '/TN', TASK_NAME]) ?? { ok: true }
		);
	}
	if (platform === 'darwin') {
		const plist = plistPath(io);
		io.write(
			plist,
			launchdPlist({ exePath: args.exePath, logPath: join(args.dir, 'data', 'agent-stdout.log') })
		);
		// Not loaded yet is fine: bootout's status is ignored.
		io.exec('launchctl', ['bootout', `gui/${io.uid}/${LAUNCHD_LABEL}`]);
		return (
			step(io, 'launchctl bootstrap', 'launchctl', ['bootstrap', `gui/${io.uid}`, plist]) ?? {
				ok: true
			}
		);
	}
	io.write(unitPath(io), systemdUserUnit({ exePath: args.exePath }));
	const manual = ['systemctl --user daemon-reload', `systemctl --user enable --now ${UNIT_NAME}`];
	// No user session bus (an ssh login, sudo): the unit is written, the owner runs the two commands.
	if (!io.env.XDG_RUNTIME_DIR) return { ok: false, manual };
	return (
		step(io, 'systemctl --user daemon-reload', 'systemctl', ['--user', 'daemon-reload']) ??
		step(io, 'systemctl --user enable --now', 'systemctl', [
			'--user',
			'enable',
			'--now',
			UNIT_NAME
		]) ?? {
			ok: true
		}
	);
}

/**
 * Stop the agent through its supervisor, so the supervisor does not start it
 * again mid-update. Windows has none to ask: install.ts stops that agent
 * through POST /setup/quit.
 */
export function stopAutostart(platform: string, io: AutostartIo = realIo()): AutostartResult {
	if (platform === 'linux') {
		return (
			step(io, 'systemctl --user stop', 'systemctl', ['--user', 'stop', UNIT_NAME]) ?? { ok: true }
		);
	}
	if (platform === 'darwin') {
		io.exec('launchctl', ['bootout', `gui/${io.uid}/${LAUNCHD_LABEL}`]);
	}
	return { ok: true };
}

/** Remove the sign-in start. The settings and the queue are left alone. */
export function unregisterAutostart(platform: string, io: AutostartIo = realIo()): AutostartResult {
	if (platform === 'win32') {
		return (
			step(io, 'schtasks /Delete', 'schtasks', ['/Delete', '/TN', TASK_NAME, '/F']) ?? { ok: true }
		);
	}
	if (platform === 'darwin') {
		io.exec('launchctl', ['bootout', `gui/${io.uid}/${LAUNCHD_LABEL}`]);
		io.remove(plistPath(io));
		return { ok: true };
	}
	io.exec('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
	io.remove(unitPath(io));
	io.exec('systemctl', ['--user', 'daemon-reload']);
	return { ok: true };
}

/**
 * The supervisor's wait before restarting a worker that crashed: 1 s, doubling
 * to 60 s; back to 1 s once a worker had run 10 minutes (it was healthy).
 */
export function nextDelay(previousMs: number, uptimeMs: number): number {
	if (previousMs <= 0 || uptimeMs >= 600_000) return 1000;
	return Math.min(previousMs * 2, 60_000);
}
