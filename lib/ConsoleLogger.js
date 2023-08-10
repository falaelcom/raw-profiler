"use strict";

const { RuntimeConfigurator } = require("./RuntimeConfigurator.js");

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
	//	Parameter: `par.runtimeConfigurator: RuntimeConfigurator` - required; `ConsoleLogger` subscribes to this instance and listens for runtime configuration changes.
	//	Parameter: `par.runtimeInitial: { verbosity: string }` - required; `ConsoleLogger` uses the values specified as properties to this object as initial configuration.
	constructor(par)
	{
		super();

		if (!par) throw new Error(`Argument is null: "par".`);
		if (!par.runtimeConfigurator) throw new Error(`Argument is null: "par.runtimeConfigurator".`);
		if (!(par.runtimeConfigurator instanceof RuntimeConfigurator)) throw new TypeError(`Type mismatch: "par.runtimeConfigurator".`);
		if (!par.runtimeInitial) throw new Error(`Argument is null: "par.runtimeInitial".`);
		if (!par.runtimeInitial.verbosity) throw new Error(`Argument is null: "par.runtimeInitial.verbosity".`);

		this.runtimeConfigurator = par.runtimeConfigurator;
		this.runtimeConfigurator.on("changed", this.runtimeConfiguration_changed.bind(this));
		this.runtimeInitial = par.runtimeInitial;

		this.verbosity = this.runtimeInitial.verbosity;
	}

	//	Function: `logBuckets(currentBucketKey: string, verbosityOverride: EVerbosity | null | void 0, buckets: object, callback: function): void` - prints to the console the data from the bucket specified by `currentBucketKey` at the
	//		currently configured level of vebosity.
	//	Parameter: `currentBucketKey: string` - required; the key of the profiling bucket to print.
	//	Parameter: `verbosityOverride: EVerbosity | null` - required; if set to `null`, `this.verbosity` setting will be used.
	//	Parameter: `buckets: object` - required; a bucket dictionary as returned by `DataCollector.formatStats`.
	//	Parameter: `callback: function` - required; a callback to invoke after the logging completes.
	logBuckets(currentBucketKey, verbosityOverride, buckets, callback)
	{
		if (!currentBucketKey) throw new Error(`Argument is null: "currentBucketKey".`);
		if (!buckets) throw new Error(`Argument is null: "buckets".`);
		if (!callback) throw new Error(`Argument is null: "callback".`);

		const headerBucket = buckets["header"];
		const currentBucket = buckets[currentBucketKey];

		if (headerBucket[verbosityOverride || this.verbosity]) console.log(headerBucket[verbosityOverride || this.verbosity]);
		if (currentBucket[verbosityOverride || this.verbosity]) console.log(currentBucket[verbosityOverride || this.verbosity]);

		return callback();
	}

	//	Function: `	getConfigurationLines(prefix: string): [{ setting: string, type: string, value: *, explanation: string | undefined }]` - lists all configuration settings relevant for this instance.
	//	Parameter: `prefix: string` - optional, defaults to null; if set, the prefix followed by a period is prepended to all setting names.
	//	Returns: A lists all configuration settings relevant for this instance, e.g.
	//	```
	//	//	with prefix === `consoleLogger`
	//	{
	//		{ setting: "consoleLogger.verbosity", type: "runtime", value: "full" }
	//	}
	//	```
	getConfigurationLines(prefix = null)
	{
		const fp = prefix ? `${prefix}.` : "";
		const result = [];
		result.push({ setting: fp + "verbosity", type: "runtime", value: this.verbosity });
		return result;
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
			case "logger.verbosity":
				this.verbosity = (value === EVerbosity.Full || value === EVerbosity.Brief || value === EVerbosity.Full) ? value : this.runtimeInitial.verbosity;
				this.onConfigurationChanged(key, this.verbosity, oldValue);
				return;
		}
	}
}

module.exports = ConsoleLogger;
module.exports.ConsoleLogger = module.exports;
