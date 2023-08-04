//	TODO: add code comments for `DataCollector.formatStats`, `DataCollector.formatMachineStats`, `DataCollector.formatHitStats`, `DataCollector.formatBucket`
"use strict";

const async = require("async");

const EventEmitter = require("events");

const { EVerbosity } = require("./EVerbosity.js");
const { RuntimeConfigurator } = require("./RuntimeConfigurator.js");
const { rep, rpad, lpad, erpad, elpad, fdate, fduration } = require("./Utility.js")

const STATE_IDLE = 1;
const STATE_WAITING = 2;
const STATE_FLUSHING = 3;
const STATE_DISABLED = 4;

//	Class: Maintains and flushes to the configured logger multiple profiling/logging data queues. Formats the incoming data for logging.
//	Runtime configuration: `DataCollector` is runtime-configuration-enabled and responds to the following runtime configuration property changes:
//		* `"sortColumn"` - specifies the default sorting column key for the profiling data table printouts; this setting is used for buckets with no `sortColumn` setting specified explicitly by
//			the `"buckets.<bucketKey>.sortColumn"` runtime configuration field;
//		* `"buckets.<bucketKey>.enabled"` - specifies explicitly whether the bucket key should be logged or not; `void 0` or `true` mean yes, `false` means no.
//		* `"buckets.<bucketKey>.sortColumn"` - specifies explicitly a sorting column for the particular bucket.
//	Events: `DataCollector` emits the following events:
//		* `"configurationChanged"`, arguments: `key, value, oldValue`
//		* `"error"`, arguments: `ncode, message, ex`
//	Remarks:
//		Queues are flushed in a non-blocking manner (a `setTimeout` call).
//		Queues are flushed with a configurable delay (`flushDelayMs`).
//		Sorting column names:
//		- `key` - unique profiling key; stats are collected per profiling key
//		- `count` - the count of profile hits for the specified key; _sorting column name: `count`_
//		- `d.` - "discrepancy". values other than 0 indicate incidents of a profiling hit point that has been hit, but never ended (the corresponding `__pfend` has not been calld yet); the value represents the number of such pending hits; it's normal to see such indications from time to time appear and disappear; a problem could be recognized, if such indications last for longer times; _sorting column name: `discrepancy`_
//		- `minms` - the shortest execution time for the specified key on record; _sorting column name: `minMs`_
//		- `avgms` - the average execution time for the specified key since the profiling has started; _sorting column name: `avgMs`_
//		- `maxms` - the longest execution time for the specified key on record; _sorting column name: `maxMs`_
//		- `totalms` - the total execution time for the specified key since the profiling has started; _sorting column names: `totalSec`, `totalMs`_
//		- `max event time` - the timepoint at which the value from `maxms` was recorded
//		- `CPU%` - the load of the OS CPU during the hit duration; if multiple CPUs are reported by the OS, the highest value is taken; it is normal for this value to be close to 100% - this means that during the profiling hit the application's main thread did not wait; _sorting column name: `avgCpu`_
//		- `minCPU%` - the minimum OS CPU load, measured for the last 1 minute at the end of a profiling hit for the specified key (this value has no direct relation to the `CPU%` value); _sorting column name: `minAvgOsCpu`_
//		- `avgCPU%` - the average OS CPU load, measured for the last 1 minute since the profiling has started for the specified key (this value has no direct relation to the `CPU%` value); _sorting column name: `avgAvgOsCpu`_
//		- `maxCPU%` - the maximum OS CPU load, measured for the last 1 minute at the end of a profiling hit for the specified key (this value has no direct relation to the `CPU%` value); _sorting column name: `maxAvgOsCpu`_
class DataCollector extends EventEmitter
{
	//	Constructor: Creates a new instance of the `DataCollector` class.
	//	Parameter: `par: object` - required.
	//	Parameter: `par.runtimeConfigurator: RuntimeConfigurator` - required; `DataCollector` subscribes to this instance and listens for runtime configuration changes.
	//	Parameter: `par.runtimeInitial: { sortColumn: string, "buckets.*"... }` - required; `DataCollector` uses the values specified as properties to this object as initial configuration.
	//	Parameter: `par.runtimeInitial["buckets.*"]: *` - optional; a mechanism to specify initial/default values foir the buckets runtime configuration that is loaded later from `__pfconfig`.
	//	Parameter: `par.logger: ConsoleLogger | FileLogger | { logBuckets: function }` - required; `DataCollector` will invoke `this.logger.logBuckets()` every time it's ready
	//		to flush collected data; see the implementation of `ConsoleLogger` and `FileLogger` for details on implementing custom loggers.
	//	Parameter: `par.flushDelayMs: uint` - required; used as a parameter for a `setTimeout` before flushing the queues.
	//	Remarks: Queue flushing is triggered on every piece of data being fed to the data collector. Once a flush request is generated, all subsequent flushed requests are ignored
	//		until all queues have been flushed. The delay `flushDelayMs` introduces allows the `DataCollector` to continue collecting more data before performing an actual flush,
	//		this way reducing the frequency of flush operations while increasing the amount of data flushed at once. There should be an optimal value large enough to mitigate
	//		the overhead of the single flush operation (e.g. opening and closing file system files) and small enogh to keep the amounts of unflushed data acceptably low.
	constructor(par)
	{
		super();

		this.runtimeConfigurator = par.runtimeConfigurator;
		this.runtimeConfigurator.on("changed", this.runtimeConfiguration_changed.bind(this));
		this.runtimeInitial = par.runtimeInitial;
		this.logger = par.logger;
		this.flushDelayMs = par.flushDelayMs;

		this.sortColumn = this.runtimeInitial.sortColumn;
		for (const key in this.runtimeInitial) if (key.indexOf("buckets.") === 0) this[key] = this.runtimeInitial[key];

		this.targetStatsMap = {};
		this.loggingState = STATE_IDLE;
		this.loggingWaitTimerId = -1;
		this.loggingCueue = [];
	}

	//	Function: Fires the "configurationChanged" event whenever a runtime configuration property's value has been changed.
	//	Parameter: `key: string` - the full property object path in the form `propName1.propName2.propName2...`.
	//	Parameter: `value: any` - the new value of the property.
	//	Parameter: `oldValue: any` - the old value of the property; on first configuration read `oldValue` is always undefined.
	onConfigurationChanged(key, value, oldValue)
	{
		this.emit("configurationChanged", key, value, oldValue);
	}

	//	Function: Fires the "error" event whenever a recoverable exception occurs.
	//	Parameter: `ncode: number` - a unique identifier for the codepoint where the error was intercepted.
	//	Parameter: `ex: Error` - the exception instance.
	//	Parameter: `message: string` - additional details about the error.
	onError(ncode, message, ex)
	{
		this.emit("error", ncode, message, ex);
	}

	//	Function: `feed(targetStats: object, hit: object): void` - Initiates delayed flush or, if one is pending, does nothing.
	//	Parameter: `targetStats: object` - required; the return value of a `ProfilerTarget.getStats()` call (see `ProfilerTarget.getStats` docs for details).
	//	Parameter: `hit: object` - required; the return value of a `ProfilerTarget.hit()` call (see `ProfilerTarget.hit` docs for details).
	//	Remarks: Silently ignores calls with disabled profiling buckets. Such situation may happen when a profiling hit was started but before it ends, the bucket
	//		associated with it becomes disabled by a runtime configuration change.
	feed(targetStats, hit)
	{
		if (!this.isBucketEnabled(hit.bucketKey)) return;
		if (this.loggingState === STATE_DISABLED) return; 
		
		const key = hit.bucketKey + "*" + hit.key;
		this.targetStatsMap[key] =
		{
			bucketKey: hit.bucketKey,
			targetStats: targetStats,
		};

		this.loggingCueue.push(
		{
			hit: hit,
			stats: this._getStats(),
			logger: this.logger,
		});

		if (this.loggingState !== STATE_IDLE) return;

		this.loggingState = STATE_WAITING;
		this.loggingWaitTimerId = setTimeout(function ()
		{
			this.loggingState = STATE_FLUSHING;
			this.loggingWaitTimerId = -1;
			return this._tryFlushLoggingCueue.bind(this)(function done(err)
			{
				this.loggingState = STATE_IDLE;
				if (err)
				{
					this.onError(2765501, "Error flushing collected data.", err);
				}
			}.bind(this));
		}.bind(this), this.flushDelayMs);
	}

	//	Function: `flush(callback(err): void, stopLogging: boolean): void` - immediately initiates the process of flushing the queues to the logger.
	//	Parameter: `callback(err): void` - required; a callback that is called when flushing finishes.
	//	Parameter: `stopLogging: boolean` - optional, defaults to `true`; if set to true, the data collector immediately starts ignoring any new data ensuring that there won't be new entries
	//		enqueued. There's no way to resume enqueueing.
	//	Remarks: This method is intended to enable flushing of the queues on app termination.
	flush(callback, stopLogging = true)
	{
		switch (this.loggingState)
		{
			case STATE_IDLE:
				if (stopLogging) this.loggingState = STATE_DISABLED;
				else this.loggingState = STATE_FLUSHING;
				return this._tryFlushLoggingCueue.bind(this)(err =>
				{
					if (!stopLogging) this.loggingState = STATE_IDLE;
					if (err)
					{
						this.onError(2768501, "Error flushing collected data.", err);
					}
					return callback(err);
				});
			case STATE_WAITING:
				clearTimeout(this.loggingWaitTimerId);
				this.loggingWaitTimerId = -1;

				if (stopLogging) this.loggingState = STATE_DISABLED;
				else this.loggingState = STATE_FLUSHING;
				return this._tryFlushLoggingCueue.bind(this)(err =>
				{
					if (!stopLogging) this.loggingState = STATE_IDLE;
					if (err)
					{
						this.onError(27655012, "Error flushing collected data.", err);
					}
					return callback(err);
				});
			case STATE_FLUSHING:
				if (stopLogging) this.loggingState = STATE_DISABLED;
				return callback(err);
			case STATE_DISABLED:
				return callback(err);
			default: this.onError(2765509, `Unknown logging state.`, new Error(`Not implemented: ${this.loggingState}.`));
		}
	}

	//	Function: `	getConfigurationLines(prefix: string): [{ setting: string, type: string, value: *, explanation: string | undefined }]` - lists all configuration settings relevant for this instance.
	//	Parameter: `prefix: string` - optional, defaults to null; if not `null`, `undefined` or `""`, the prefix followed by a period is prepended to all setting names.
	//	Returns: A lists all configuration settings relevant for this instance, e.g.
	//	```
	//	//	with prefix === `dataCollector`
	//	{
	//		{ setting: "dataCollector.enabled", type: "runtime", value: true },
	//		{ setting: "dataCollector.sortColumn", type: "runtime", value: "maxMs" },
	//		{ setting: "dataCollector.buckets.DB.verbosity", type: "runtime", value: "brief" },
	//		{ setting: "dataCollector.flushDelayMs", type: "preconf", value: 0 },
	//		{ setting: "dataCollector.logger", type: "preconf", value: "ConsoleLogger" },
	//		{ setting: "dataCollector.logger.verbosity", type: "runtime", value: "full" },
	//	}
	//	```
	getConfigurationLines(prefix = null)
	{
		const fp = prefix ? `${prefix}.` : "";
		let result = [];

		result.push({ setting: fp + "enabled", type: "runtime", value: this.enabled });
		result.push({ setting: fp + "sortColumn", type: "runtime", value: this.sortColumn });
		for (const key in this) if (key.indexOf("buckets.") === 0) result.push({ setting: fp + key, type: "runtime", value: this[key] });
		result.push({ setting: fp + "flushDelayMs", type: "preconf", value: this.flushDelayMs });
		result.push({ setting: fp + "logger", type: "preconf", value: this.logger?.constructor.name });

		this.logger?.getConfigurationLines && (result = result.concat(this.logger.getConfigurationLines(fp + "logger")));
		return result;
	}

	//	Property: Gets the enabled state for the data collector as currently configured by the runtime configuraiton.
	//	Remarks:
	//		Disabling the data collector effectively disables any profiling and logging, except for machine stats collection (see `MachineStats`).
	get enabled()
	{
		this.runtimeConfigurator.asyncSmartRefresh();
		return this.runtimeConfigurator.enabled;
	}

	//	Function: `isBucketEnabled(bucketKey: string)` - gets the enabled state for the specified bucket as currently configured by the runtime configuraiton.
	//	Parameter: `bucketKey: string` - the key of the bucket to test.
	//	Runtime configuration field: `"buckets." + RuntimeConfigurator.escapeConfigurationKeySegment(bucketKey) + ".enabled"`
	//	Remarks: This function ignores the data collector enabled state. The full code to test the effective enabled state of a bucket would be:
	//	```
	//		if (!dataCollector.enabled) return false;
	//		if (!bucketKey) return true;
	//		return dataCollector.isBucketEnabled(bucketKey);
	//	```
	isBucketEnabled(bucketKey)
	{
		this.runtimeConfigurator.asyncSmartRefresh();
		const key = "buckets." + RuntimeConfigurator.escapeConfigurationKeySegment(bucketKey) + ".enabled";
		return this[key] !== false;
	}

	//	Function: `getBucketSortColumn(bucketKey: string)` - gets the sorting column used with profiling table printouts for the specified bucket as currently configured by the runtime configuraiton.
	//	Parameter: `bucketKey: string` - the key of the bucket to test.
	//	Runtime configuration field: `"buckets." + RuntimeConfigurator.escapeConfigurationKeySegment(bucketKey) + ".sortColumn"`
	//	Remarks: Defaults to the default sorting column (see constructor).
	getBucketSortColumn(bucketKey)
	{
		this.runtimeConfigurator.asyncSmartRefresh();
		const key = "buckets." + RuntimeConfigurator.escapeConfigurationKeySegment(bucketKey) + ".sortColumn";
		return this[key] || this.sortColumn;
	}

	//	Function: `getBucketVerbosity(bucketKey: string)` - gets the verbosity override for the specified bucket.
	//	Parameter: `bucketKey: string` - the key of the bucket to query.
	//	Runtime configuration field: `"buckets." + RuntimeConfigurator.escapeConfigurationKeySegment(bucketKey) + ".verbosity"`
	//	Remarks: Defaults to null.
	getBucketVerbosity(bucketKey)
	{
		this.runtimeConfigurator.asyncSmartRefresh();
		const key = "buckets." + RuntimeConfigurator.escapeConfigurationKeySegment(bucketKey) + ".verbosity";
		return this[key] || null;
	}


	//	Function: Handles runtime configuration changes.
	runtimeConfiguration_changed(key, value, oldValue)
	{
		if (this.loggingState === STATE_DISABLED) return; 

		switch (key)
		{
			case "sortColumn":
				this.sortColumn = value || this.runtimeInitial.sortColumn;
				this.onConfigurationChanged(key, this.sortColumn, oldValue);
				return;
		}

		if (key.indexOf("buckets.") === 0)
		{
			this[key] = value;
			this.onConfigurationChanged(key, value, oldValue);
		}
	}

	_tryFlushLoggingCueue(callback)
	{
		return async.whilst(
			function test(test_callback)
			{
				return test_callback(null, this.loggingCueue.length != 0);
			}.bind(this),
			function execute(next)
			{
				const item = this.loggingCueue.shift();
				if (!item)
				{
					return next();
				}
				return async.waterfall(
				[
					function (next)
					{
						return setImmediate(function () { return next() });
					}.bind(this),
					function (next)
					{
						return DataCollector.formatStats(
							item.stats,
							item.hit.time,
							item.hit.title,
							item.hit.currentMachineStats,
							item.hit.currentHitStats,
							item.hit.key,
							next);
					}.bind(this),
					function (buckets, next)
					{
						return setImmediate(function () { return next(null, buckets) });
					}.bind(this),
					function (buckets, next)
					{
						return item.logger.logBuckets(item.hit.bucketKey, this.getBucketVerbosity(item.hit.bucketKey), buckets, next);
					}.bind(this)
				], next);
			}.bind(this),
			callback
		);
	}

	_getStats(ascending)
	{
		ascending = !!ascending;

		const result = {};
		for (const key in this.targetStatsMap)
		{
			const item = this.targetStatsMap[key];
			let bucket = result[item.bucketKey];
			if (!bucket)
			{
				bucket = [];
				result[item.bucketKey] = bucket;
			}
			bucket.push(item.targetStats);
		}

		for (const bucketKey in result)
		{
			const bucket = result[bucketKey];
			const sortPropertyName = this.getBucketSortColumn(bucketKey);
			bucket.sort(function (left, right)
			{
				const leftValue = left[sortPropertyName];
				const rightValue = right[sortPropertyName];

				if ((!leftValue && leftValue !== 0) || (!rightValue && rightValue !== 0))
				{
					this.onError(634253, `Possibly wrong sort column name: ${JSON.stringify(sortPropertyName)}, compare values: ${JSON.stringify(leftValue)}, ${JSON.stringify(rightValue)}.`, new Error("Sorting error."));
				}

				if (ascending)
				{
					return leftValue - rightValue;
				}

				return rightValue - leftValue;
			});
		}

		return result;
	}


	static formatStats(stats, time, title, currentMachineStats, currentHitStats, currentHitKey, callback)
	{
		try
		{
			const result = {};
			const headerBucket = {};
			result["header"] = headerBucket;

			const sb = [];

			sb.push(fdate(time) + " - " + title);
			sb.push('\n');

			headerBucket.log = sb.join("");

			if (currentMachineStats)
			{
				sb.push(DataCollector.formatMachineStats(currentMachineStats));
				sb.push('\n');
				sb.push(DataCollector.formatHitStats(currentHitStats));
			}

			headerBucket[EVerbosity.Brief] = sb.join("");
			headerBucket[EVerbosity.Full] = headerBucket.brief;

			return async.eachOfSeries(stats, function (bucket, bucketKey, next)
			{
				return setImmediate(function ()
				{
					try
					{
						result[bucketKey] = DataCollector.formatBucket(bucketKey, bucket, currentHitKey);
						return next();
					}
					catch (ex)
					{
						return next(new Error(ex));
					}
				});
			},
			function done()
			{
				return callback(null, result);
			});
		}
		catch (ex)
		{
			return callback(new Error(ex));
		}
	}

	static formatMachineStats(machineStats)
	{
		const delimiter = "│ ";
		const rowSize = 100;
		const psColSize = 40;
		const osColSize = 40;
		const labelColSize = rowSize - psColSize - osColSize - 2 * delimiter.length;

		const sb = [];
		sb.push(rep(rowSize, "─"));
		sb.push('\n');

		function printMetric(label, psValue, osValue)
		{
			sb.push(erpad(label, labelColSize));
			sb.push(delimiter);
			sb.push(erpad(psValue, psColSize));
			sb.push(delimiter);
			sb.push(erpad(osValue, osColSize));
			sb.push('│');
			sb.push('\n');
		}

		printMetric("Metric", "Process", "OS");
		sb.push(rep(rowSize, "─"));
		sb.push('\n');
		printMetric("Uptime", fduration(machineStats.psUptime * 1000), fduration(machineStats.osUptime * 1000));
		const cpuAvgText = "1 min: " + Math.round(machineStats.osAvgLoad_end) + "% " +
			"5 min: " + Math.round(machineStats.osAvgLoad5min_end) + "% " +
			"15 min: " + Math.round(machineStats.osAvgLoad5min_end) + "%";
		printMetric("CPU avg", "n/a", cpuAvgText);

		const psCpuText = "CPU kernel: " + machineStats.psCpuUsage + "%, app: " + machineStats.psCpuUsage_application + "%";
		const sbOsCpuText = [];
		for (let length = machineStats.osCpusUsage.length, i = 0; i < length; ++i)
		{
			if (i)
			{
				sbOsCpuText.push(", ");
			}
			sbOsCpuText.push(i + ": " + machineStats.osCpusUsage[i] + "%");
		}
		sbOsCpuText.push(", MAX: " + machineStats.osMaxCpu + "%");
		printMetric("CPU", psCpuText, sbOsCpuText.join(""));

		printMetric("RAM",
			machineStats.psMemUsage_begin + "% -> " + machineStats.psMemUsage_end + "% (D " + machineStats.psMemUsage_delta + "%)",
			machineStats.osMemUsage_begin + "% -> " + machineStats.osMemUsage_end + "% (D " + machineStats.osMemUsage_delta + "%)"
		);

		sb.push(rep(rowSize, "─"));

		return sb.join("");
	}

	static formatHitStats(hitStats)
	{
		const delimiter = " │ ";

		const diffLocalIndexColSize = 10;
		const hitLocalIndexColSize = 10;
		const doneLocalIndexColSize = 10;
		const diffIndexColSize = 10;
		const hitIndexColSize = 10;
		const doneIndexColSize = 10;
		const diffOpenHitsCountColSize = 10;
		const hitOpenHitsCountColSize = 10;
		const doneOpenHitsCountColSize = 10;
		const durationColSize = 10;
		const avgCpuColSize = 10;

		const sb = [];

		function printRow(fields)
		{
			sb.push(lpad(fields.diffLocalIndex, diffLocalIndexColSize, ' '));
			sb.push(delimiter);
			sb.push(lpad(fields.hitLocalIndex, hitLocalIndexColSize, ' '));
			sb.push(delimiter);
			sb.push(lpad(fields.doneLocalIndex, doneLocalIndexColSize, ' '));
			sb.push(delimiter);
			sb.push(lpad(fields.diffIndex, diffIndexColSize, ' '));
			sb.push(delimiter);
			sb.push(lpad(fields.hitIndex, hitIndexColSize, ' '));
			sb.push(delimiter);
			sb.push(lpad(fields.doneIndex, doneIndexColSize, ' '));
			sb.push(delimiter);
			sb.push(lpad(fields.diffOpenHitsCount, diffOpenHitsCountColSize, ' '));
			sb.push(delimiter);
			sb.push(lpad(fields.hitOpenHitsCount, hitOpenHitsCountColSize, ' '));
			sb.push(delimiter);
			sb.push(lpad(fields.doneOpenHitsCount, doneOpenHitsCountColSize, ' '));
			sb.push(delimiter);
			sb.push(rpad(fields.duration, durationColSize, ' '));
			sb.push(delimiter);
			sb.push(lpad(fields.avgCpu, avgCpuColSize, ' '));
			sb.push(" │");
		}

		printRow(
			{
				diffLocalIndex: "delta LN",
				hitLocalIndex: "->LN",
				doneLocalIndex: "LN->",
				diffIndex: "delta N",
				hitIndex: "->N",
				doneIndex: "N->",
				diffOpenHitsCount: "delta open",
				hitOpenHitsCount: "->open",
				doneOpenHitsCount: "open->",
				duration: "duration",
				avgCpu: "CPU%",
			});
		const rowSize = sb.join("").length;
		sb.push('\n');
		sb.push(rep(rowSize, "─"));
		sb.push('\n');

		printRow(
			{
				diffLocalIndex: String(hitStats.diffLocalIndex),
				hitLocalIndex: String(hitStats.hitLocalIndex),
				doneLocalIndex: String(hitStats.doneLocalIndex),
				diffIndex: String(hitStats.diffIndex),
				hitIndex: String(hitStats.hitIndex),
				doneIndex: String(hitStats.doneIndex),
				diffOpenHitsCount: String(hitStats.diffOpenHitsCount),
				hitOpenHitsCount: String(hitStats.hitOpenHitsCount),
				doneOpenHitsCount: String(hitStats.doneOpenHitsCount),
				duration: fduration(hitStats.ms),
				avgCpu: String(hitStats.avgCpu) + "%",
			});

		sb.push('\n');
		sb.push(rep(rowSize, "─"));

		return sb.join("");
	}

	static formatBucket(bucketKey, bucket, currentHitKey)
	{
		const delimiter = " │ ";

		function printStat(sb, stat, isCurrent)
		{
			let keyFieldWidth = 71;

			const discrepancy = parseInt(stat.discrepancy);
			if (!isNaN(discrepancy) && discrepancy != 0)
			{
				sb.push(rpad("!!!", 4, ' '));
			}
			else
			{
				keyFieldWidth += 4;
			}

			if (stat.bucketKey)
			{
				keyFieldWidth -= stat.bucketKey.length + 2;
				sb.push("[" + stat.bucketKey + "]");
			}

			if (isCurrent)
			{
				sb.push(erpad("> " + stat.key, keyFieldWidth));
			}
			else
			{
				sb.push(erpad(stat.key, keyFieldWidth));
			}
			sb.push(delimiter);
			sb.push(lpad(stat.count, 5, ' '));
			sb.push(delimiter);
			sb.push(lpad(stat.discrepancy, 2, ' '));
			sb.push(delimiter);
			sb.push(elpad(stat.minMs + "ms", 10, ' '));
			sb.push(delimiter);
			sb.push(elpad(stat.avgMs + "ms", 10, ' '));
			sb.push(delimiter);
			sb.push(elpad(stat.maxMs + "ms", 10, ' '));
			sb.push(delimiter);
			if (stat.totalSec > 0)
			{
				sb.push(elpad(stat.totalSec + "s", 7, ' '));
			}
			else
			{
				sb.push(elpad(stat.totalMs + "ms", 7, ' '));
			}
			sb.push(delimiter);
			sb.push(fdate(stat.maxDateTime));
			sb.push(delimiter);
			sb.push(lpad(stat.avgCpu + "%", 4, ' '));
			sb.push(delimiter);
			sb.push(lpad(stat.minAvgOsCpu + "%", 7, ' '));
			sb.push(delimiter);
			sb.push(lpad(stat.avgAvgOsCpu + "%", 7, ' '));
			sb.push(delimiter);
			sb.push(lpad(stat.maxAvgOsCpu + "%", 7, ' '));
			sb.push(delimiter);
		}

		const headerDef =
		{
			bucketKey: bucketKey,
			key: "key",
			count: "count",
			discrepancy: "d.",
			minMs: "min",
			avgMs: "avg",
			maxMs: "max",
			totalSec: "total",
			totalMs: "total",
			avgCpu: "CPU",
			minAvgOsCpu: "minCPU",
			avgAvgOsCpu: "avgCPU",
			maxAvgOsCpu: "maxCPU",
			maxDateTime: "max event time",
		};

		const sb = [];
		const sbBrief = [];
		const headerStart = sb.join("").length;

		printStat(sb, headerDef);
		printStat(sbBrief, headerDef);

		const headerEnd = sb.join("").length;
		const rowSize = headerEnd - headerStart - 2;

		sb.push('\n');
		sb.push(rep(rowSize, "─"));
		sb.push('\n');

		sbBrief.push('\n');
		sbBrief.push(rep(rowSize, "─"));
		sbBrief.push('\n');

		for (let length = bucket.length, i = 0; i < length; ++i)
		{
			const item = bucket[i];

			printStat(sb, item, currentHitKey == item.key);
			sb.push('\n');

			if (currentHitKey == item.key)
			{
				printStat(sbBrief, item, true);
				sbBrief.push('\n');
			}
		}

		sb.push(rep(rowSize, "─"));
		sb.push('\n');

		sbBrief.push(rep(rowSize, "─"));
		sbBrief.push('\n');

		return {
			log: null,
			full: sb.join(""),
			brief: sbBrief.join(""),
		};
	}
}

module.exports = DataCollector;
module.exports.DataCollector = module.exports;
