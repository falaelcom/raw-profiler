"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const async = require("async");

const EventEmitter = require("events");
class AsyncEventEmitter extends EventEmitter
{
	async emitAsync(eventName, ...args)
	{
		const listeners = this.listeners(eventName);
		for (let listener of listeners)
		{
			await listener(...args);
		}
	}
}

//	Class: Facilitates asynchronous reloading of configuration deltaConfig at runtime.
//	Events: `ConsoleLogger` emits the following events:
//		* `"changed"`, arguments: `key, value, oldValue, source, ctimes`
//		* `"refreshFinished"`, arguments: `hasChanged: boolean`
//		* `"configurationChanged"`, arguments: `key, value, oldValue, source, ctimes`
//	Remarks: Only supports numeric, string and boolean configuration values.
class RemoteRuntimeConfigurator extends AsyncEventEmitter
{
	//	Parameter: `par: { initialEnabled }`.
	//	Parameter: `par.initialEnabled: boolean` - defaults to `true`; provides an initial value for the profiler enabled state before the command file has been queried for the first time.
	//	Parameter: `par.remoteConfigRequestTimeoutMs: uint` - optional, defaults to `5000`.
	//	Parameter: `par.repeatOnRemoteConfigFailureIntervalMs: uint` - optional, defaults to `60000`.
	//	Parameter: `par.remoteConfigPollingIntervalMs: uint` - optional, defaults to `1000`; specifies the time between continuous tests whether profiling has been reenabled with remote configuration.
	//	Remarks:
	//		Only supports numeric, string and boolean configuration values.
	//		Subscribe for the `changed` event to listen for runtime configuration changes: `new RemoteRuntimeConfigurator({...}).on("changed", (key, value, oldValue, source, ctimes) => {...})`.
	constructor(par)
	{
		super();

		if (!par) throw new Error(`Argument is null: "par".`);
		if (par.initialEnabled !== void 0 && par.initialEnabled !== true && par.initialEnabled !== false) throw new TypeError(`Type mismatch: "par.initialEnabled".`);
		if (par.remoteConfigRequestTimeoutMs !== void 0 && par.remoteConfigRequestTimeoutMs !== null && isNaN(par.remoteConfigRequestTimeoutMs)) throw new TypeError(`Type mismatch: "par.remoteConfigRequestTimeoutMs".`);
		if (par.repeatOnRemoteConfigFailureIntervalMs !== void 0 && par.repeatOnRemoteConfigFailureIntervalMs !== null && isNaN(par.repeatOnRemoteConfigFailureIntervalMs)) throw new TypeError(`Type mismatch: "par.repeatOnRemoteConfigFailureIntervalMs".`);
		if (par.remoteConfigPollingIntervalMs !== void 0 && par.remoteConfigPollingIntervalMs !== null && isNaN(par.remoteConfigPollingIntervalMs)) throw new TypeError(`Type mismatch: "par.remoteConfigPollingIntervalMs".`); 

		this._initialEnabled = par.initialEnabled !== false;
		this._enabled = null;
		this.remoteConfigRequestTimeoutMs = par.remoteConfigRequestTimeoutMs || 5000;
		this.repeatOnRemoteConfigFailureIntervalMs = par.repeatOnRemoteConfigFailureIntervalMs || 60000;
		this.remoteConfigPollingIntervalMs = par.remoteConfigPollingIntervalMs || 1000;

		this.remoteCtimes = { commandFile: null, configurationFile: null };
		this.data = {};
	}

	//	Function: Fires the "changed" event whenever a runtime configuration property's value has been changed.
	//	Parameter: `key: string` - the full property object path in the form `propName1.propName2.propName2...`.
	//	Parameter: `value: any` - the new value of the property.
	//	Parameter: `oldValue: any` - the old value of the property; on first configuration read `oldValue` is always undefined.
	//	Parameter: `source: string` - the source of the new value; one of:
	//		- `"commandFile"` - only with `key === "enabled"`; indicates that setting has been updated from the command file (`__pfenable`);
	//		- `"configFile"` - indicates that setting has been updated from the configuration file (`__pfconfig`);
	//		- `"prop"` - indicates that setting has been updated when a property of this instance was set.
	//		- `"remote"` - indicates that setting has been updated on the remote data collector server.
	//	Parameter: `ctimes: { commandFile: uint | null, configurationFile: uint | null } | void 0` - optional; `null` times mean the corresponding file could not be accessed for whatever reason; not set with `source === "prop"`.
	//	Remarks: This event is fired for the first time on the configuration first read only for runtime congiguration properties that are not undefined.
	async onChanged(key, value, oldValue, source, ctimes)
	{
		await this.emitAsync("changed", key, value, oldValue, source, ctimes);
	}

	//	Function: Fires the "changed" event whenever a runtime configuration property's value has been changed.
	//	Parameter: `hasChanged: boolean` - .
	//	Parameter: `ctimes: { commandFile: uint | null, configurationFile: uint | null }` - `null` times mean the corresponding file could not be accessed for whatever reason.
	//	Remarks: This event is fired whenever the runtine configuration has changed.
	onRefreshFinished(hasChanged)
	{
		this.emit("refreshFinished", hasChanged, { commandFile: null, configurationFile: null });
	}

	onConfigurationChanged(key, value, oldValue, source, ctimes)
	{
		this.emit("configurationChanged", key, value, oldValue, source, ctimes);
	}

	inspectFeedBody(body)
	{
		body.cts = [this.remoteCtimes.commandFile, this.remoteCtimes.configurationFile];
		//console.log(555.001, "inspectFeedBody", this.remoteCtimes, body.cts);
		return body;
	}

	async inspectFeedResponse(responseBody, response)
	{
		switch (response.status)
		{
			case 200:	//	configuration changed
				const { ctimes, deltaConfig = null, currentConfig } = JSON.parse(responseBody);	//	`deltaConfig` might be `void 0` with the `/conf` endpoint and no setting updates since `this.remoteCtimes`
				this.remoteCtimes = ctimes;
				if (!deltaConfig) break;
				for (const key in deltaConfig)
				{
					const item = deltaConfig[key];
					if (key === "enabled")
					{
						this.onConfigurationChanged("enabled", item.value, this._enabled, "remote", ctimes);
						this._enabled = item.value;
					}
					await this.onChanged(key, item.value, item.oldValue, "remote", ctimes);
				}
				this.onRefreshFinished(true, ctimes);
				//console.log(999.001, "configuration changed", ctimes, this.remoteCtimes, deltaConfig, currentConfig);
				break;
			case 204:	//	configuration unchanged
				//console.log(999.002, "no configuration changedes");
				break;
			default:
				throw new Error(`Unexpected response status code ${response.status}.`);
		}
	}

	async inspectConfigPollingResponse(response)
	{
		switch (response.status)
		{
			case 200:
				const responseBody = await response.text();
				const { ctimes } = JSON.parse(responseBody);
				//console.log(999.999, ctimes.commandFile, "old", this.remoteCtimes.commandFile);
				this.remoteCtimes.commandFile = ctimes.commandFile;
				if (!this._enabled)
				{
					this.onConfigurationChanged("enabled", true, false, "remote", ctimes);
					this._enabled = true;
					await this.onChanged("enabled", true, false, "remote", ctimes);
				}
				break;
			case 204:
				//console.log(999.004, "still disabled", this._enabled);
				break;
			default:
				throw new Error(`Unexpected response status code ${response.status}.`);
		}
	}

	asyncSmartRefresh(callback)
	{
		return callback?.(false);
	}

	//	Function: `	getConfigurationLines(prefix: string): [{ setting: string, type: string, value: *, explanation: string | undefined }]` - lists all configuration settings relevant for this instance.
	//	Parameter: `prefix: string` - optional, defaults to null; if not `null`, `undefined` or `""`, the prefix followed by a period is prepended to all setting names.
	//	Returns: A lists all configuration settings relevant for this instance, e.g.
	//	```
	//	//	with prefix === `RemoteRuntimeConfigurator`
	//	{
	//		{ setting: "remoteRuntimeConfigurator.useRemoteConfig", type: "hardcod", value: true },
	//		{ setting: "remoteRuntimeConfigurator.remoteConfigRequestTimeoutMs", type: "preconf", value: 5000 },
	//		{ setting: "remoteRuntimeConfigurator.repeatOnRemoteConfigFailureIntervalMs", type: "preconf", value: 60000 },
	//		{ setting: "remoteRuntimeConfigurator.remoteConfigPollingIntervalMs", type: "preconf", value: 1000 },
	//	}
	//	```
	getConfigurationLines(prefix = null)
	{
		const fp = prefix ? `${prefix}.` : "";
		let result = [];

		result.push({ setting: fp + "useRemoteConfig", type: "hardcod", value: this.useRemoteConfig });
		result.push({ setting: fp + "remoteConfigRequestTimeoutMs", type: "preconf", value: this.remoteConfigRequestTimeoutMs });
		result.push({ setting: fp + "repeatOnRemoteConfigFailureIntervalMs", type: "preconf", value: this.repeatOnRemoteConfigFailureIntervalMs });
		result.push({ setting: fp + "remoteConfigPollingIntervalMs", type: "preconf", value: this.remoteConfigPollingIntervalMs });

		return result;
	}

	get enabled()
	{
		return this._enabled === null ? this._initialEnabled : this._enabled;
	}

	set enabled(value)
	{
		if (value !== true && value !== false) throw new TypeError(`Argument is null: "value".`);
		if (this._enabled === value) return;
		this._enabled = value;
		this.onChanged("enabled", this._enabled, !this._enabled, "prop");
	}

	get useRemoteConfig()
	{
		return true;
	}
}

module.exports = RemoteRuntimeConfigurator;
module.exports.RemoteRuntimeConfigurator = module.exports;
