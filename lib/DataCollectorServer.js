"use strict";

const EventEmitter = require("events");

//	Class: The `DataCollectorServer` class provides the necessary facilities to launch a loggin server.
//	Events: `DataCollector` emits the following events:
//		* `"info"`, arguments: `message`
//		* `"error"`, arguments: `ncode, message, ex`
//		* `"configurationChanged"`, arguments: `key, value, oldValue, source, ctimes`
//	See also: `DataCollectorHttpProxy`.
class DataCollectorServer extends EventEmitter
{
	//	Constructor: Creates a new instance of the `DataCollectorServer` class.
	//	Parameter: `par: object` - required.
	//	Parameter: `par.host: string` - required; a host name or IP address to listen on, e.g. `"0.0.0.0"`.
	//	Parameter: `par.port: uint` - required; an HTTP port to listen on, e.g. `9666`.
	//	Parameter: `par.createDataCollector(sourceKey: string): DataCollector | DataCollectorHttpProxy | { feed(targetStats, hit): void, enabled: boolean, isBucketEnabled(bucketKey): boolean }` -
	//		required; a callback used by the `DataCollectorServer` to instantiate new data collector instances; for custom implementations, see `DataCollector` and `DataCollectorHttpProxy` for
	//		implementation details.
	//	Parameter: `par.runtimeConfigurator: RuntimeConfigurator` - required; `DataCollectorServer` subscribes to this instance and listens for runtime configuration changes.
	constructor(par)
	{
		super();

		if (!par) throw new Error(`Argument is null: "par".`);
		if (!par.host) throw new Error(`Argument is null: "par.host".`);
		if (!par.port) throw new Error(`Argument is null: "par.port".`);
		if (!par.createDataCollector) throw new Error(`Argument is null: "par.createDataCollector".`);
		if (!par.runtimeConfigurator) throw new Error(`Argument is null: "par.runtimeConfigurator".`);

		this.host = par.host;
		this.port = par.port;
		this.createDataCollector = par.createDataCollector;
		this.runtimeConfigurator = par.runtimeConfigurator;
		this.runtimeConfigurator.on("changed", this.runtimeConfiguration_changed.bind(this));

		this.dataCollectors = {};
		this.configurationCache = {};											//	`{ "property.name": { ctimes, source, value, oldValue } }`
		this.configurationCtimes = { commandFile: 0, configurationFile: 0 };	//	if no runtime config is ever loaded, both values stay `0`; compared to client ctimes (`0` or more) will be always less and no configuration delta will be computed.
		this.remoteConfigStore = {};											//	`{ "property.name": value }`
	}

	//	Function: Fires the "info" event whenever operation information is available.
	//	Parameter: `message: string` - additional details about the error.
	onInfo(message)
	{
		this.emit("info", message);
	}

	//	Function: Fires the "error" event whenever a recoverable exception occurs.
	//	Parameter: `ncode: number` - a unique identifier for the codepoint where the error was intercepted.
	//	Parameter: `ex: Error` - the exception instance.
	//	Parameter: `message: string` - additional details about the error.
	onError(ncode, message, ex)
	{
		this.emit("error", ncode, message, ex);
	}

	//	Function: Fires the "configurationChanged" event whenever a runtime configuration property's value has been changed.
	//	Parameter: `key: string` - the full property object path in the form `propName1.propName2.propName2...`.
	//	Parameter: `value: any` - the new value of the property.
	//	Parameter: `oldValue: any` - the old value of the property; on first configuration read `oldValue` is always undefined.
	//	Parameter: `source: string` - indicates the source for the update of ths setting (see `RuntimeConfigurator.onChanged`, `RemoteRuntimeConfigurator.onChanged`).
	//	Parameter: `ctimes: { commandFile: uint | null, configurationFile: uint | null } | void 0` - optional; `null` times mean the corresponding file could not be accessed for whatever reason; not set with `source === "prop"`.
	onConfigurationChanged(key, value, oldValue, source, ctimes)
	{
		this.configurationCache[key] = { ctimes, source, value, oldValue };
		this.configurationCtimes = ctimes;
		this.emit("configurationChanged", key, value, oldValue, source, ctimes);
	}

	//	Function: `run(par: { getSourceCallback(req, res): string })` - Start the logging server.
	//	Parameter: `par.getSourceCallback(req, res): string` - implement this callback to provide custom `sourceKey` extraction logic for incoming requests, for Ex. from query string or X- headers
	//		added via nginx.
	//	Endpoints:
	//		- `/feed`
	//	Remarks:
	//		The default `sourceKey` extraction logic for incoming requests relies on`connection.remoteAddress || req.socket.remoteAddress || connection.socket.remoteAddress`.
	//		The resulting source key combines the extracted source key with `req.body.sourceKey` if present.
	//		`bodyParser` limits the incoming requests to 31MB.
	run(par)
	{
		const getSourceCallback = par ? par.getSourceCallback : null;
		function __getSource(req, res)
		{
			let result;
			if (getSourceCallback)
			{
				result = getSourceCallback(req, res) || "";
			}
			else
			{
				const connection = req.connection || {};
				const socket = req.socket || connection.socket || {};
				result = connection.remoteAddress || socket.remoteAddress || "";
			}
			result = result.replace(/\D/g, '.');
			if (req.body.sourceKey)
			{
				const strippedSourceKey = req.body.sourceKey.replace(/([^a-z0-9_\-]+)/gi, "-");
				result += "-" + strippedSourceKey;
			}
			return result;
		}

		process.on('uncaughtException', (err, origin) => this.onError(47563845, origin, err));

		const express = require('express');
		const methodOverride = require('method-override');
		const bodyParser = require('body-parser');

		const app = express();

		app.use(methodOverride());
		app.use(bodyParser.json({
			limit: '31mb'
		}));
		app.use(bodyParser.urlencoded({
			extended: true,
			limit: '31mb'
		}));

		//	`req.body.hit` - required
		//	`req.body.targetStats` - required
		//	`req.body.cts: [uint, uint]` - optional, only in remote config mode
		app.post('/feed', (req, res) =>
		{
			const sourceKey = __getSource(req, res);

			//	profiling hit
			if (req.body.hit)
			{
				req.body.hit.time = new Date(req.body.hit.time);
				req.body.targetStats.maxDateTime = new Date(req.body.targetStats.maxDateTime);
				this._ensureDataCollector(sourceKey).feed(req.body.targetStats, req.body.hit);

				//console.log(910, "====================================");
				//console.log(911, req.body.cts, this.configurationCtimes);

				if (!req.body.cts) return res.status(204).end();

				//console.log(912, req.body.cts, this.configurationCache);
				//console.log(913, req.body.cts, this.remoteConfigStore);

				const deltaConfig = this.__buildConfigurationDelta(req.body.cts);	//	lists all settings updated after the times specified in `req.body.cts`

				//console.log(914, req.body.cts, deltaConfig);

				if (!deltaConfig) return res.status(204).end();						//	no changes

				return res.json({ ctimes: this.configurationCtimes, deltaConfig, currentConfig: this.remoteConfigStore });
			}

			//	logging data
			req.body.time = new Date(req.body.time);
			this._ensureDataCollector(sourceKey).log(req.body.bucketKey, req.body.text, req.body.time);

			//console.log(810, "====================================");
			//console.log(811, req.body.cts, this.configurationCtimes);

			if (!req.body.cts) return res.status(204).end();

			//console.log(812, req.body.cts, this.configurationCache);
			//console.log(813, req.body.cts, this.remoteConfigStore);

			const deltaConfig = this.__buildConfigurationDelta(req.body.cts);	//	lists all settings updated after the times specified in `req.body.cts`

			//console.log(814, req.body.cts, deltaConfig);

			if (!deltaConfig) return res.status(204).end();						//	no changes

			return res.json({ ctimes: this.configurationCtimes, deltaConfig, currentConfig: this.remoteConfigStore });
		});

		//	`req.body.cts: [uint, uint]` - required; available only in remote config mode
		app.post('/conf', (req, res) =>
		{
			if (!req.body.cts) return res.status(400).end();

			return this.runtimeConfigurator.asyncSmartRefresh(() =>
			{
				const deltaConfig = this.__buildConfigurationDelta(req.body.cts);													//	lists all settings updated after the times specified in `req.body.cts`
				if (!deltaConfig) return res.json({ ctimes: this.configurationCtimes, currentConfig: this.remoteConfigStore });		//	no changes

				return res.json({ ctimes: this.configurationCtimes, deltaConfig, currentConfig: this.remoteConfigStore });
			});
		});

		app.get('/e', (req, res) =>
		{
			return this.runtimeConfigurator.asyncSmartRefresh(() =>
			{
				this.remoteConfigStore.enabled === true ? res.json({ ctimes: this.configurationCtimes }) : res.status(204).end();
			});
		});

		this.runtimeConfigurator.asyncSmartRefresh(() =>
		{
			app.listen(this.port, this.host);
			this.onInfo(`Data collector server listenig on "${this.host}:${this.port}"`);
		});
		return this;
	}

	//	Function: `getRemoteConfigurationLines(prefix: string): [{ setting: string, type: string, value: *, explanation: string | undefined }]` - lists all configuration settings relevant for remote configuration.
	//	Parameter: `prefix: string` - optional, defaults to null; if not `null`, `undefined` or `""`, the prefix followed by a period is prepended to all setting names.
	//	Returns: A lists all configuration settings relevant for remote configuration (will be sent to remote sources via `/feed` and `/conf` responses), e.g.
	//	```
	//	//	with prefix === `remoteConf`
	//	{
	//		{ setting: "remoteConf.enabled", type: "runtime", value: true },
	//		{ setting: "remoteConf.uri", type: "runtime", value: "http://localhost:8081" },
	//		{ setting: "remoteConf.requestTimeoutMs", type: "runtime", value: 5000 },
	//		{ setting: "remoteConf.failureTimeoutMs", type: "runtime", value: "(unset)" },
	//		{ setting: "remoteConf.buckets.DB.verbosity", type: "runtime", value: "brief" },
	//	}
	//	```
	getRemoteConfigurationLines(prefix = null)
	{
		const fp = prefix ? `${prefix}.` : "";
		let result = [];
		result.push({ setting: fp + "enabled", type: "runtime", value: this.remoteConfigStore.enabled !== void 0 ? this.remoteConfigStore.enabled : "(unset)" });
		result.push({ setting: fp + "uri", type: "runtime", value: this.remoteConfigStore.uri !== void 0 ? this.remoteConfigStore.uri : "(unset)" });
		result.push({ setting: fp + "requestTimeoutMs", type: "runtime", value: this.remoteConfigStore.requestTimeoutMs !== void 0 ? this.remoteConfigStore.requestTimeoutMs : "(unset)" });
		result.push({ setting: fp + "failureTimeoutMs", type: "runtime", value: this.remoteConfigStore.failureTimeoutMs !== void 0 ? this.remoteConfigStore.failureTimeoutMs : "(unset)" });
		for (const key in this.remoteConfigStore) if (key.indexOf("buckets.") === 0) result.push({ setting: fp + key, type: "runtime", value: this.remoteConfigStore[key] });
		return result;
	}

	//	Function: `printConfigurationLines(): string` - returns a string containing a formatted multiline list of all effective configuration settings related to the server and to profiling.
	//	Returns: a string containing a formatted multiline list of all effective configuration settings related to the server and to profiling, e.g.
	//	```
	//	```
	//	Remarks: "preconf" - a hardcoded setting that cannot be modified at run time; "runtime" - a setting can be modified at run time.
	printConfigurationLines()
	{
		const runtimeConfiguratorLines = this.runtimeConfigurator.getConfigurationLines("runtimeConfigurator");

		let sb = "";
		sb += `[raw-profiler] *preconf* host = ${JSON.stringify(this.host)}`;
		sb += "\n" + `[raw-profiler] *preconf* port = ${JSON.stringify(this.port)}`;
		for (let length = runtimeConfiguratorLines.length, i = 0; i < length; ++i)
		{
			const item = runtimeConfiguratorLines[i];
			sb += "\n" + `[raw-profiler] *${item.type}* ${item.setting} = ${JSON.stringify(item.value)}`;
			item.explanation && (sb += ` (${item.explanation})`);
		}
		const outcome2 = this.getRemoteConfigurationLines("remoteConfig");
		for (let length = outcome2.length, i = 0; i < length; ++i)
		{
			const item = outcome2[i];
			sb += "\n[raw-profiler] " + `*${item.type}* ${item.setting} = ${JSON.stringify(item.value)}`;
			item.explanation && (sb += ` (${item.explanation})`);
		}
		for (const key in this.dataCollectors)
		{
			sb += "\n[raw-profiler] ---------------------------------\n" + `[raw-profiler] data collector ${key}` + "\n[raw-profiler] ---------------------------------";
			const dataCollector = this.dataCollectors[key];
			const outcome = dataCollector.runtimeConfigurator.getConfigurationLines("runtimeConfigurator").concat(dataCollector.getConfigurationLines("dataCollector"));
			for (let length = outcome.length, i = 0; i < length; ++i)
			{
				const item = outcome[i];
				sb += "\n[raw-profiler] " + `*${item.type}* ${item.setting} = ${JSON.stringify(item.value)}`;
				item.explanation && (sb += ` (${item.explanation})`);
			}
		}
		return sb;
	}

	//	Function: Handles runtime configuration changes.
	//	Remarks: Keep in sync with `DataCollectorHttpProxy.runtimeConfiguration_changed`!
	runtimeConfiguration_changed(key, value, oldValue, source, ctimes)
	{
		switch (key)
		{
			case "enabled":
				this.remoteConfigStore.enabled = value;
				this.onConfigurationChanged(key, this.remoteConfigStore.enabled, oldValue, source, ctimes);
				return;
			case "proxy.uri":
				this.remoteConfigStore.uri = value;
				this.onConfigurationChanged(key, this.remoteConfigStore.uri, oldValue, source, ctimes);
				return;
			case "proxy.requestTimeoutMs":
				this.remoteConfigStore.requestTimeoutMs = value;
				this.onConfigurationChanged(key, this.remoteConfigStore.requestTimeoutMs, oldValue, source, ctimes);
				return;
			case "proxy.failureTimeoutMs":
				this.remoteConfigStore.failureTimeoutMs = value;
				this.onConfigurationChanged(key, this.remoteConfigStore.failureTimeoutMs, oldValue, source, ctimes);
				return;
		}

		if (key.indexOf("buckets.") === 0 && key.indexOf("enabled") === key.length - "enabled".length)
		{
			this.remoteConfigStore[key] = value;
			this.onConfigurationChanged(key, value, oldValue, source, ctimes);
		}
	}

	_ensureDataCollector(sourceKey)
	{
		let result = this.dataCollectors[sourceKey];
		if (result) return result;
		result = this.dataCollectors[sourceKey] = this.createDataCollector(sourceKey, this.runtimeConfigurator.data);
		this.onInfo(`Profiling client connected: "${sourceKey}".` + "\n[raw-profiler] =================================\n" + "[raw-profiler] Effective config\n[raw-profiler] =================================\n" + this.printConfigurationLines());
		return result;
	}

	__buildConfigurationDelta(client_cts)
	{
		const result = {};
		let hasDelta = false;
		for (const key in this.configurationCache)
		{
			const { ctimes, source, value, oldValue } = this.configurationCache[key];
			const client_ctimes = { commandFile: client_cts[0] || 0, configurationFile: client_cts[1] || 0 };	//	`client_cts[n] === null` means that this client has not yet been configured remotely; 
			//		translating `null` to `0` means that any server - side ctimes will be found to be
			//		larger and the corresponding settings will be included in the delta

			if (client_ctimes.commandFile >= ctimes.commandFile && client_ctimes.configurationFile >= ctimes.configurationFile) continue;
			//	`client_ctimes` can be larger thant the ctimes for individual settings because the client
			//		keeps only the latest ctimes of any change while individual settings keep the ctimes
			//		when they were changed individually
			result[key] = { source, value, oldValue };
			hasDelta = true;
		}
		if (!hasDelta) return null;
		return result;
	}

}

module.exports = DataCollectorServer;
module.exports.DataCollectorServer = module.exports;
