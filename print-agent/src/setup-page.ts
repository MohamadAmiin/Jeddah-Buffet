// THE AGENT'S SETUP PAGE (tasks/print-agent-installer T-06), served by setup.ts
// at http://127.0.0.1:<port>/setup on the till PC.
//
// Three static strings: the page, its script and its stylesheet. The CSP that
// setup.ts sends ("default-src 'none'; script-src 'self'; style-src 'self'; …")
// forbids inline script, inline style and event-handler attributes, so the HTML
// is fully static, the script only toggles `hidden` and sets textContent (never
// innerHTML), and the stylesheet uses CSS SYSTEM COLOURS (Canvas, CanvasText,
// ButtonFace, Field, Highlight …): they follow the PC's light or dark theme with
// the platform's own contrast, and no colour literal exists in this file. The
// app's design tokens (src/lib/styles/tokens.css) cannot reach it: this program
// imports nothing from src/.
//
// The setup key arrives in the URL FRAGMENT (#s=…), which a browser never sends
// to any server; the script keeps it in this tab's sessionStorage — the agent's
// own origin, not the app's — and drops the fragment from the address bar.
// Every status line pairs a glyph with words (● ◆ ○ ✕): colour never carries
// the meaning alone.
//
// SETUP_JS is a String.raw template so its regular expressions keep their
// backslashes; the script therefore uses no backtick and no "${".

export const SETUP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>matcami print agent</title>
<link rel="stylesheet" href="/setup.css">
<script src="/setup.js" defer></script>
</head>
<body>
<main>
<h1>matcami print agent</h1>
<p id="nokey" hidden>Open this page from the matcami print agent: run the file you downloaded again, and it opens this page with its key.</p>
<div id="app" hidden>
<section aria-labelledby="status-h">
<h2 id="status-h">Status</h2>
<ul id="status" aria-live="polite"></ul>
</section>
<p id="alert" role="alert" hidden></p>
<section aria-labelledby="printers-h">
<h2 id="printers-h">Printers</h2>
<form id="printers" novalidate>
<fieldset>
<legend>Where is the receipt printer?</legend>
<label><input type="radio" name="receiptKind" value="local" checked> Plugged into this PC (USB), or installed on it</label>
<label><input type="radio" name="receiptKind" value="network"> On the network (IP address)</label>
</fieldset>
<div id="receiptLocal">
<label for="receiptName">Printer on this PC</label>
<select id="receiptName"></select>
<p id="receiptNone" hidden>○ This PC lists no printer. Plug it in and add it in the PC's own printer settings, then press Refresh the list.</p>
</div>
<div id="receiptNetwork" hidden>
<label for="receipt">Receipt printer address (IP)</label>
<input id="receipt" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="192.168.1.50">
</div>
<fieldset>
<legend>Receipt paper width</legend>
<label><input type="radio" name="receiptWidth" value="32"> 58 mm paper (32 columns)</label>
<label><input type="radio" name="receiptWidth" value="48" checked> 80 mm paper (48 columns)</label>
</fieldset>
<label class="check"><input type="checkbox" id="hasKitchen"> Separate kitchen printer</label>
<div id="kitchenFields" hidden>
<fieldset>
<legend>Where is the kitchen printer?</legend>
<label><input type="radio" name="kitchenKind" value="local" checked> Plugged into this PC (USB), or installed on it</label>
<label><input type="radio" name="kitchenKind" value="network"> On the network (IP address)</label>
</fieldset>
<div id="kitchenLocal">
<label for="kitchenName">Printer on this PC</label>
<select id="kitchenName"></select>
<p id="kitchenNone" hidden>○ This PC lists no printer.</p>
</div>
<div id="kitchenNetwork" hidden>
<label for="kitchen">Kitchen printer address (IP)</label>
<input id="kitchen" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="192.168.1.51">
</div>
<fieldset>
<legend>Kitchen paper width</legend>
<label><input type="radio" name="kitchenWidth" value="32" checked> 58 mm paper (32 columns)</label>
<label><input type="radio" name="kitchenWidth" value="48"> 80 mm paper (48 columns)</label>
</fieldset>
</div>
<button type="submit">Save printers</button>
<button type="button" id="refreshLocal">Refresh the list</button>
</form>
<p id="printersResult" aria-live="polite"></p>
</section>
<section aria-labelledby="actions-h">
<h2 id="actions-h">Test and pair</h2>
<button type="button" id="testPrint">Test print</button>
<button type="button" id="openPairing">Open pairing for a till</button>
<p><a id="tillLink" href="/setup" target="_blank" rel="noopener">Open the till's Printer page</a></p>
<p id="actionsResult" aria-live="polite"></p>
</section>
<details>
<summary>Advanced</summary>
<form id="originForm" novalidate>
<label for="origin">The app address this agent answers</label>
<input id="origin" type="text" inputmode="url" autocomplete="off" spellcheck="false">
<label class="check"><input type="checkbox" id="originConfirm"> Tills paired under the current address will stop printing until they pair again</label>
<button type="submit">Change the app address</button>
</form>
<form id="rekeyForm" novalidate>
<label class="check"><input type="checkbox" id="rekeyConfirm"> Every till must pair again</label>
<button type="submit">Reset the pairing key</button>
</form>
<p id="advancedResult" aria-live="polite"></p>
</details>
</div>
</main>
</body>
</html>
`;

export const SETUP_CSS = `:root {
	color-scheme: light dark;
	font-family: system-ui, sans-serif;
	line-height: 1.5;
}
body {
	margin: 0;
	background: Canvas;
	color: CanvasText;
}
main {
	box-sizing: border-box;
	max-width: 40rem;
	margin: 0 auto;
	padding: 1rem;
}
h1 {
	font-size: 1.5rem;
	margin: 0.5rem 0 1rem;
}
h2 {
	font-size: 1.125rem;
	margin: 1.5rem 0 0.5rem;
}
#status {
	list-style: none;
	margin: 0;
	padding: 0;
}
#status li {
	padding: 0.25rem 0;
	overflow-wrap: anywhere;
}
label {
	display: block;
	margin: 0.75rem 0 0.25rem;
}
fieldset {
	border: 1px solid GrayText;
	border-radius: 0.5rem;
	margin: 0.75rem 0;
	padding: 0.25rem 0.75rem;
}
fieldset label,
label.check {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	min-height: 3rem;
	margin: 0;
}
input[type='text'] {
	box-sizing: border-box;
	width: 100%;
	min-height: 3rem;
	padding: 0 0.75rem;
	font: inherit;
	background: Field;
	color: FieldText;
	border: 1px solid ButtonText;
	border-radius: 0.5rem;
}
input[type='radio'],
input[type='checkbox'] {
	width: 1.25rem;
	height: 1.25rem;
	flex: none;
}
button {
	min-height: 3rem;
	margin: 0.5rem 0.5rem 0 0;
	padding: 0 1rem;
	font: inherit;
	background: ButtonFace;
	color: ButtonText;
	border: 1px solid ButtonText;
	border-radius: 0.5rem;
	cursor: pointer;
}
summary {
	display: flex;
	align-items: center;
	min-height: 3rem;
	cursor: pointer;
}
a {
	color: LinkText;
}
button:focus-visible,
input:focus-visible,
a:focus-visible,
summary:focus-visible {
	outline: 3px solid Highlight;
	outline-offset: 2px;
}
[role='alert'] {
	border: 1px solid CanvasText;
	border-radius: 0.5rem;
	padding: 0.75rem;
}
[hidden] {
	display: none !important;
}
`;

export const SETUP_JS = String.raw`(function () {
	'use strict';
	var KEY = 'matcami-setup-secret';
	var $ = function (id) {
		return document.getElementById(id);
	};
	var fromHash = new URLSearchParams(location.hash.slice(1)).get('s') || '';
	var secret = fromHash;
	try {
		if (fromHash) sessionStorage.setItem(KEY, fromHash);
		else secret = sessionStorage.getItem(KEY) || '';
	} catch (e) {
		// Storage blocked: the key from the fragment still works for this page load.
	}
	// The key never stays in the address bar.
	if (location.hash) history.replaceState(null, '', '/setup');
	if (!/^[0-9a-f]{64}$/.test(secret)) {
		$('nokey').hidden = false;
		return;
	}
	$('app').hidden = false;

	var STOPPED = '✕ The print agent stopped answering. Run the file you downloaded again.';
	var prefilled = false;
	var current = null;

	function say(id, text) {
		$(id).textContent = text;
	}
	function alertBox(text) {
		var box = $('alert');
		box.textContent = text;
		box.hidden = !text;
	}

	async function api(path, body) {
		var res = await fetch(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Setup-Secret': secret },
			body: JSON.stringify(body || {}),
			credentials: 'omit',
			cache: 'no-store'
		});
		var data = null;
		try {
			data = await res.json();
		} catch (e) {
			data = null;
		}
		return { status: res.status, data: data };
	}

	function paper(width) {
		return width === 32 ? '58 mm' : '80 mm';
	}
	function printerLine(label, p) {
		if (!p) return label + ': ○ Not set';
		var where = (p.name ? p.name + ' (this PC)' : p.host + ':' + p.port) + ' · ' + paper(p.width);
		var waiting = p.queued ? ' · ' + p.queued + ' waiting' : '';
		return p.reachable
			? label + ': ● ' + where + ' · ready' + waiting
			: label + ': ◆ ' + where + ' · unreachable' + waiting;
	}
	function pairingLine(state) {
		if (state === 'open') return '◆ Pairing open — press Pair this till on the till';
		if (state === 'claimed') return '● A till is paired';
		return '○ Pairing closed';
	}
	function addressOf(p) {
		return p.port === 9100 ? p.host : p.host + ':' + p.port;
	}
	function checkWidth(name, width) {
		var radios = document.querySelectorAll('input[name="' + name + '"]');
		for (var i = 0; i < radios.length; i++) radios[i].checked = Number(radios[i].value) === width;
	}
	function widthOf(name) {
		var picked = document.querySelector('input[name="' + name + '"]:checked');
		return picked ? Number(picked.value) : 48;
	}
	function kindOf(name) {
		var picked = document.querySelector('input[name="' + name + '"]:checked');
		return picked ? picked.value : 'local';
	}
	function checkKind(name, kind) {
		var radios = document.querySelectorAll('input[name="' + name + '"]');
		for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === kind;
		showKind(name === 'receiptKind' ? 'receipt' : 'kitchen');
	}
	function showKind(printer) {
		var local = kindOf(printer + 'Kind') === 'local';
		$(printer + 'Local').hidden = !local;
		$(printer + 'Network').hidden = local;
	}

	// The printers this PC's print service knows — a USB printer is one of them.
	var localPrinters = [];
	function configuredName(id) {
		var p = current && current.printers[id === 'receiptName' ? 'receipt' : 'kitchen'];
		return p && p.name ? p.name : '';
	}
	function fillSelect(id) {
		var select = $(id);
		// What the owner picked, else the printer the agent has NOW: the list
		// arrives after the one-time prefill, and a save must never switch the
		// printer to whichever is first on the list.
		var want = select.value || configuredName(id);
		select.textContent = '';
		var listed = false;
		localPrinters.forEach(function (p) {
			var option = document.createElement('option');
			option.value = p.name;
			option.textContent =
				p.name +
				(p.state === 'stopped' ? ' — not reachable now' : p.state === 'unknown' ? '' : ' — ready');
			select.appendChild(option);
			if (p.name === want) listed = true;
		});
		if (want && !listed) {
			var missing = document.createElement('option');
			missing.value = want;
			missing.textContent = want + ' — not listed on this PC now';
			select.appendChild(missing);
		}
		if (want) select.value = want;
		var none = id === 'receiptName' ? 'receiptNone' : 'kitchenNone';
		$(none).hidden = localPrinters.length > 0;
	}
	async function loadLocal() {
		var answer;
		try {
			answer = await api('/setup/local-printers');
		} catch (e) {
			return;
		}
		if (answer.status !== 200 || !answer.data || !Array.isArray(answer.data.printers)) return;
		localPrinters = answer.data.printers;
		fillSelect('receiptName');
		fillSelect('kitchenName');
		// Nothing set yet: start on what this PC has, else on the network.
		if (current && !current.printers.receipt && !kindTouched) {
			checkKind('receiptKind', localPrinters.length > 0 ? 'local' : 'network');
		}
	}
	var kindTouched = false;

	async function refresh() {
		var answer;
		try {
			answer = await api('/setup/state');
		} catch (e) {
			alertBox(STOPPED);
			return;
		}
		if (answer.status !== 200 || !answer.data) {
			alertBox('✕ The print agent refused this page’s key. Run the file you downloaded again.');
			return;
		}
		alertBox('');
		current = answer.data;
		var list = $('status');
		list.textContent = '';
		var built = current.builtAt ? ', built ' + current.builtAt.slice(0, 10) : '';
		[
			'● Running — version ' + current.agentVersion + built,
			'● Answers ' + current.origin,
			pairingLine(current.pairing),
			printerLine('Receipt printer', current.printers.receipt),
			printerLine('Kitchen printer', current.printers.kitchen)
		].forEach(function (text) {
			var li = document.createElement('li');
			li.textContent = text;
			list.appendChild(li);
		});
		$('tillLink').href = current.origin + '/pos/printer';
		if (!prefilled) {
			prefilled = true;
			$('origin').value = current.origin;
			var r = current.printers.receipt;
			var k = current.printers.kitchen;
			if (r) {
				kindTouched = true;
				checkKind('receiptKind', r.name ? 'local' : 'network');
				if (r.name) $('receiptName').value = r.name;
				else $('receipt').value = addressOf(r);
				checkWidth('receiptWidth', r.width);
			}
			$('hasKitchen').checked = !!k;
			$('kitchenFields').hidden = !k;
			if (k) {
				checkKind('kitchenKind', k.name ? 'local' : 'network');
				if (k.name) $('kitchenName').value = k.name;
				else $('kitchen').value = addressOf(k);
				checkWidth('kitchenWidth', k.width);
			}
			loadLocal();
		}
	}

	function parseAddress(text) {
		var m = /^(.+?)(?::(\d{1,5}))?$/.exec(text.trim());
		if (!m || /[\s/]/.test(m[1])) return null;
		var port = m[2] ? Number(m[2]) : 9100;
		if (port < 1 || port > 65535) return null;
		return { host: m[1], port: port };
	}
	function fieldWords(field) {
		var printer = field.indexOf('kitchen') === 0 ? 'kitchen' : 'receipt';
		if (/width$/.test(field)) return printer + ' paper width';
		if (/name$/.test(field)) return printer + ' printer on this PC';
		if (/port$/.test(field)) return printer + ' printer port';
		return printer + ' printer address';
	}

	$('hasKitchen').addEventListener('change', function () {
		$('kitchenFields').hidden = !$('hasKitchen').checked;
	});
	['receiptKind', 'kitchenKind'].forEach(function (name) {
		var radios = document.querySelectorAll('input[name="' + name + '"]');
		for (var i = 0; i < radios.length; i++) {
			radios[i].addEventListener('change', function () {
				kindTouched = true;
				showKind(name === 'receiptKind' ? 'receipt' : 'kitchen');
			});
		}
	});
	$('refreshLocal').addEventListener('click', function () {
		loadLocal();
	});

	/** The chosen printer as the API takes it, or null with the sentence to show. */
	function readPrinter(printer) {
		if (kindOf(printer + 'Kind') === 'local') {
			var name = $(printer + 'Name').value;
			if (!name) return { error: '✕ Pick the ' + printer + ' printer from the list — or plug it in and press Refresh the list' };
			return { value: { name: name, width: widthOf(printer + 'Width') } };
		}
		var address = parseAddress($(printer).value);
		if (!address)
			return {
				error:
					'✕ Enter the ' + printer + ' printer’s IP address, e.g. ' + (printer === 'kitchen' ? '192.168.1.51' : '192.168.1.50')
			};
		address.width = widthOf(printer + 'Width');
		return { value: address };
	}

	$('printers').addEventListener('submit', async function (event) {
		event.preventDefault();
		var receipt = readPrinter('receipt');
		if (receipt.error) {
			say('printersResult', receipt.error);
			return;
		}
		var kitchen = { value: null };
		if ($('hasKitchen').checked) {
			kitchen = readPrinter('kitchen');
			if (kitchen.error) {
				say('printersResult', kitchen.error);
				return;
			}
		}
		var answer;
		try {
			answer = await api('/setup/printers', { receipt: receipt.value, kitchen: kitchen.value });
		} catch (e) {
			alertBox(STOPPED);
			return;
		}
		if (answer.status === 200) say('printersResult', '● Saved. Press Test print.');
		else if (answer.status === 409 && answer.data)
			say(
				'printersResult',
				'◆ ' +
					answer.data.queued +
					(answer.data.target === 'kitchen' ? ' kitchen tickets are' : ' receipts are') +
					' waiting for the old printer. Let them print, or reconnect it, before changing the paper width.'
			);
		else if (answer.status === 422 && answer.data && answer.data.field)
			say('printersResult', '✕ Check the ' + fieldWords(answer.data.field));
		else say('printersResult', '✕ The printers were not saved (' + answer.status + ')');
		refresh();
	});

	$('testPrint').addEventListener('click', async function () {
		var answer;
		try {
			answer = await api('/setup/test-print');
		} catch (e) {
			alertBox(STOPPED);
			return;
		}
		if (answer.status === 202) say('actionsResult', '● Test page sent');
		else if (answer.status === 503) say('actionsResult', '○ Set the receipt printer first');
		else say('actionsResult', '✕ The test page was not sent (' + answer.status + ')');
		refresh();
	});

	$('openPairing').addEventListener('click', async function () {
		try {
			await api('/setup/pairing');
		} catch (e) {
			alertBox(STOPPED);
			return;
		}
		say('actionsResult', '◆ Pairing open — on the till, signed in as the owner: Printer → Pair this till');
		refresh();
	});

	$('originForm').addEventListener('submit', async function (event) {
		event.preventDefault();
		if (!$('originConfirm').checked) {
			say('advancedResult', '✕ Tick the box first');
			return;
		}
		var answer;
		try {
			answer = await api('/setup/origin', { origin: $('origin').value.trim(), confirm: true });
		} catch (e) {
			alertBox(STOPPED);
			return;
		}
		if (answer.status === 200 && answer.data)
			say('advancedResult', '● The agent now answers ' + answer.data.origin + '. Pair the till again.');
		else
			say('advancedResult', '✕ Enter the address exactly as the till opens it, starting with https://');
		$('originConfirm').checked = false;
		refresh();
	});

	$('rekeyForm').addEventListener('submit', async function (event) {
		event.preventDefault();
		if (!$('rekeyConfirm').checked) {
			say('advancedResult', '✕ Tick the box first');
			return;
		}
		var answer;
		try {
			answer = await api('/setup/rekey', { confirm: true });
		} catch (e) {
			alertBox(STOPPED);
			return;
		}
		say(
			'advancedResult',
			answer.status === 200
				? '● New pairing key. Pair every till again.'
				: '✕ The pairing key was not reset (' + answer.status + ')'
		);
		$('rekeyConfirm').checked = false;
		refresh();
	});

	refresh();
	setInterval(refresh, 15000);
})();
`;
