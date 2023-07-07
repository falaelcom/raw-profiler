"use strict";

const { RuntimeConfiguration } = require("./RuntimeConfiguration.js");

const EventEmitter = require("events");

//	Class: Provides the ability for the `DataCollector` to write collected data to stdout.
//	Runtime configuration: `ConsoleLogger` is runtime-configuration-enabled and responds to the following runtime configuration property changes:
//		* `"verbosity"` - the amount of detail in the output is determined based on the currently configured level of verbosity
//	Events: `ConsoleLogger` emits the following events:
//		* `"configurationChanged"`, arguments: `key, value, oldValue`
class ConsoleLogger extends EventEmitter
{
	//	Creates a new instance of `ConsoleLogger` with given initial configuration and state.
	//	Parameter: `par: object` - required.
	//	Parameter: `par.runtimeConfiguration: RuntimeConfiguration` - required; `ConsoleLogger` subscribes to this instance and listens for runtime configuration changes.
	//	Parameter: `par.fallbackConfiguration: { verbosity: string }` - required; `ConsoleLogger` uses the values specified as properties to this object as initial configuration.
	constructor(par)
	{
		super();

		if (!par) throw new Error(`Argument is null: "par".`);
		if (!par.runtimeConfiguration) throw new Error(`Argument is null: "par.runtimeConfiguration".`);
		if (!(par.runtimeConfiguration instanceof RuntimeConfiguration)) throw new TypeError(`Type mismatch: "par.runtimeConfiguration".`);
		if (!par.fallbackConfiguration) throw new Error(`Argument is null: "par.fallbackConfiguration".`);
		if (!par.fallbackConfiguration.verbosity) throw new Error(`Argument is null: "par.fallbackConfiguration.verbosity".`);

		this.runtimeConfiguration = par.runtimeConfiguration;
		this.runtimeConfiguration.on("changed", this.runtimeConfiguration_changed.bind(this));
		this.fallbackConfiguration = par.fallbackConfiguration;

		this.verbosity = this.fallbackConfiguration.verbosity;
	}

	//	Function: Fires the "configurationChanged" event whenever a runtime configuration property's value has been changed.
	//	Parameter: `key: string` - the full property object path in the form `propName1.propName2.propName2...`.
	//	Parameter: `value: any` - the new value of the property.
	//	Parameter: `oldValue: any` - the old value of the property; on first configuration read `oldValue` is always undefined.
	onConfigurationChanged(key, value, oldValue)
	{
		this.emit("configurationChanged", key, value, oldValue);
	}

	//	Function: Handles runtime configuration changes.
	runtimeConfiguration_changed(key, value, oldValue)
	{
		switch (key)
		{
			case "verbosity":
				this.verbosity = value || this.fallbackConfiguration.verbosity;
				this.onConfigurationChanged(key, this.verbosity, oldValue);
				return;
		}
	}

	//	Function: `logBuckets(currentBucketKey: string, buckets: object, callback: function): void` - prints to the console the data from the bucket specified by `currentBucketKey` at the
	//		currently configured level of vebosity.
	//	Parameter: `currentBucketKey: string` - required; the key of the profiling bucket to print.
	//	Parameter: `buckets: object` - required; a bucket dictionary as returned by `DataCollector.formatStats`.
	//	Parameter: `callback: function` - required; a callback to invoke after the logging completes.
	logBuckets(currentBucketKey, buckets, callback)
	{
		if (!currentBucketKey) throw new Error(`Argument is null: "currentBucketKey".`);
		if (!buckets) throw new Error(`Argument is null: "buckets".`);
		if (!callback) throw new Error(`Argument is null: "callback".`);

		const headerBucket = buckets["header"];
		const currentBucket = buckets[currentBucketKey];

		if (headerBucket[this.verbosity]) console.log(headerBucket[this.verbosity]);
		if (currentBucket[this.verbosity]) console.log(currentBucket[this.verbosity]);

		return callback();
	}
}

module.exports = ConsoleLogger;
module.exports.ConsoleLogger = module.exports;
