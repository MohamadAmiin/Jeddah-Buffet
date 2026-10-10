import { describe, expect, it } from 'vitest';
import {
	launchdPlist,
	nextDelay,
	registerAutostart,
	stopAutostart,
	systemdUserUnit,
	unregisterAutostart,
	windowsTaskXml,
	type AutostartIo
} from './autostart.ts';

/** Records every command and every file write instead of touching the PC. */
function fakeIo(env: Record<string, string | undefined> = {}, failOn?: string) {
	const calls: Array<{ cmd: string; args: string[] }> = [];
	const files = new Map<string, string | Buffer>();
	const removed: string[] = [];
	const io: AutostartIo = {
		exec: (cmd, args) => {
			calls.push({ cmd, args });
			const failing = failOn !== undefined && [cmd, ...args].join(' ').includes(failOn);
			return { status: failing ? 1 : 0, stdout: '', stderr: failing ? 'refused' : '' };
		},
		env,
		home: '/home/till',
		uid: 501,
		write: (path, data) => files.set(path, data),
		remove: (path) => removed.push(path)
	};
	return { io, calls, files, removed };
}

describe('the Windows logon task XML', () => {
	const taskXml = windowsTaskXml({
		exePath: 'C:\\Users\\a\\AppData\\Local\\matcami\\print-agent\\bin\\matcami-print-agent.exe',
		userId: 'TILL\\cashier'
	});

	// One assertion per element, so a dropped setting fails by name.
	it.each([
		'<LogonTrigger><Enabled>true</Enabled><UserId>TILL\\cashier</UserId></LogonTrigger>',
		'<Principal id="Author"><UserId>TILL\\cashier</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>',
		'<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
		'<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
		'<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
		'<StartWhenAvailable>true</StartWhenAvailable>',
		'<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
		'<IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd></IdleSettings>',
		'<AllowStartOnDemand>true</AllowStartOnDemand>',
		'<Enabled>true</Enabled>',
		'<Hidden>false</Hidden>',
		'<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
		'<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>',
		'<Exec><Command>C:\\Users\\a\\AppData\\Local\\matcami\\print-agent\\bin\\matcami-print-agent.exe</Command><Arguments>run --detach</Arguments></Exec>',
		'xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"'
	])('carries %s', (element) => {
		expect(taskXml).toContain(element);
	});

	it('escapes the path and the user', () => {
		const odd = windowsTaskXml({ exePath: 'C:\\R&D\\<x>.exe', userId: 'A&B\\c' });
		expect(odd).toContain('<Command>C:\\R&amp;D\\&lt;x&gt;.exe</Command>');
		expect(odd).toContain('<UserId>A&amp;B\\c</UserId>');
	});
});

describe('the systemd user unit and the LaunchAgent', () => {
	it('quotes ExecStart for systemd: spaces kept, % and $ doubled, restarted on failure', () => {
		const unit = systemdUserUnit({ exePath: '/home/a b/x%y$z' });
		expect(unit).toContain('ExecStart="/home/a b/x%%y$$z" run');
		expect(unit).toContain('Restart=on-failure');
		expect(unit).toContain('WantedBy=default.target');
	});

	it('the plist restarts a crash, stays down after a clean quit, and starts at load', () => {
		const plist = launchdPlist({ exePath: '/Users/a/x', logPath: '/Users/a/log' });
		expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
		expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
		expect(plist).toContain('<string>com.matcami.print-agent</string>');
		expect(plist).toMatch(/<string>\/Users\/a\/x<\/string>\s*<string>run<\/string>/);
	});
});

describe('registerAutostart', () => {
	it('Windows: writes the XML as UTF-16LE with a BOM, creates the task, then runs it', () => {
		const { io, calls, files } = fakeIo({ USERDOMAIN: 'TILL', USERNAME: 'cashier' });
		const result = registerAutostart('win32', { exePath: 'C:\\x\\agent.exe', dir: 'C:\\x' }, io);
		expect(result).toEqual({ ok: true });
		const xmlFile = files.get('C:\\x\\task.xml') as Buffer;
		expect(xmlFile.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
		expect(xmlFile.toString('utf16le')).toContain('<UserId>TILL\\cashier</UserId>');
		expect(calls).toEqual([
			{
				cmd: 'schtasks',
				args: ['/Create', '/TN', 'matcami print agent', '/XML', 'C:\\x\\task.xml', '/F']
			},
			{ cmd: 'schtasks', args: ['/Run', '/TN', 'matcami print agent'] }
		]);
	});

	it('Windows: a refused schtasks is reported with its step, not thrown', () => {
		const { io } = fakeIo({ USERNAME: 'cashier' }, '/Create');
		expect(registerAutostart('win32', { exePath: 'C:\\x\\a.exe', dir: 'C:\\x' }, io)).toEqual({
			ok: false,
			step: 'schtasks /Create',
			stderr: 'refused'
		});
	});

	it('Linux with no user session bus: writes the unit, runs nothing, hands back the two commands', () => {
		const { io, calls, files } = fakeIo({});
		const result = registerAutostart('linux', { exePath: '/opt/agent', dir: '/home/till/x' }, io);
		expect(result).toEqual({
			ok: false,
			manual: [
				'systemctl --user daemon-reload',
				'systemctl --user enable --now matcami-print-agent'
			]
		});
		expect(calls).toEqual([]);
		expect(files.get('/home/till/.config/systemd/user/matcami-print-agent.service')).toContain(
			'ExecStart="/opt/agent" run'
		);
	});

	it('Linux with a session: writes the unit, reloads, enables and starts it', () => {
		const { io, calls } = fakeIo({ XDG_RUNTIME_DIR: '/run/user/1000' });
		expect(registerAutostart('linux', { exePath: '/opt/agent', dir: '/x' }, io)).toEqual({
			ok: true
		});
		expect(calls).toEqual([
			{ cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
			{ cmd: 'systemctl', args: ['--user', 'enable', '--now', 'matcami-print-agent'] }
		]);
	});

	it('macOS: writes the LaunchAgent, boots out any old copy, bootstraps the new one', () => {
		const { io, calls, files } = fakeIo({});
		expect(
			registerAutostart('darwin', { exePath: '/Users/a/agent', dir: '/Users/a/m' }, io)
		).toEqual({
			ok: true
		});
		expect(files.get('/home/till/Library/LaunchAgents/com.matcami.print-agent.plist')).toContain(
			'<string>/Users/a/m/data/agent-stdout.log</string>'
		);
		expect(calls).toEqual([
			{ cmd: 'launchctl', args: ['bootout', 'gui/501/com.matcami.print-agent'] },
			{
				cmd: 'launchctl',
				args: [
					'bootstrap',
					'gui/501',
					'/home/till/Library/LaunchAgents/com.matcami.print-agent.plist'
				]
			}
		]);
	});
});

describe('stop and unregister', () => {
	it('stop goes through the supervisor on Linux and macOS, and does nothing on Windows', () => {
		const linux = fakeIo();
		stopAutostart('linux', linux.io);
		expect(linux.calls).toEqual([
			{ cmd: 'systemctl', args: ['--user', 'stop', 'matcami-print-agent'] }
		]);
		const mac = fakeIo();
		stopAutostart('darwin', mac.io);
		expect(mac.calls[0]!.args[0]).toBe('bootout');
		const win = fakeIo();
		expect(stopAutostart('win32', win.io)).toEqual({ ok: true });
		expect(win.calls).toEqual([]);
	});

	it('unregister removes the sign-in start on each OS', () => {
		const win = fakeIo();
		unregisterAutostart('win32', win.io);
		expect(win.calls).toEqual([
			{ cmd: 'schtasks', args: ['/Delete', '/TN', 'matcami print agent', '/F'] }
		]);
		const linux = fakeIo();
		unregisterAutostart('linux', linux.io);
		expect(linux.removed).toEqual(['/home/till/.config/systemd/user/matcami-print-agent.service']);
		const mac = fakeIo();
		unregisterAutostart('darwin', mac.io);
		expect(mac.removed).toEqual(['/home/till/Library/LaunchAgents/com.matcami.print-agent.plist']);
	});
});

describe('nextDelay — the Windows supervisor’s back-off', () => {
	it('1 s, doubling to a 60 s cap', () => {
		const seen: number[] = [];
		let delay = 0;
		for (let i = 0; i < 9; i += 1) seen.push((delay = nextDelay(delay, 5)));
		expect(seen).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
	});

	it('back to 1 s after a worker ran ten minutes', () => {
		expect(nextDelay(32000, 600_000)).toBe(1000);
		expect(nextDelay(32000, 599_999)).toBe(60000);
	});
});
