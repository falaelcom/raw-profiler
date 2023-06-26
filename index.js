const fs = require("fs");
const path = require("path");
const os = require("os");
const archiver = require("archiver");
const async = require("async");

const COMMAND_FILE_NAME = "__pfenable";
const FILE_LOGGER_DIRECTORY = "__pflogs";
const DEFAULT_LOG_DELAY_MS = 0;
const HOME_DIRECTORY = process.env.HOME || process.env.USERPROFILE;	//	HOME in linux, USERPROFILE in windows

const configurationFileName = "__pfconfig";
const configurationRefreshSilenceTimeoutMs = 5000;
const configField_sortColumn = "sortColumn";
const defaultSortColumn = "maxMs";
const configField_archivePath = "archivePath";
const configField_verbosity = "verbosity";
const EVerbosity =
{
	Log: "log",
	Brief: "brief",
	Full: "full",
}
const defaultVerbosity = "full";
const configField_buckets = "buckets";

//#region Profiler
function Profiler(configuration)
{
	this.configuration = configuration;

	this.targetMap = {};

	this.dataCollector = new DataCollector(this.configuration);

	this.openHitsCount = 0;
	this.hitCount = 0;

	this.config({});
}

Profiler.prototype.config = function(par)
{
	this.dataCollector = par.dataCollector || new DataCollector(this.configuration);
	this.dataCollector.config(par);
}

Profiler.prototype.begin = function(bucket, key, title)
{
	this.openHitsCount++;
	this.hitCount++;
	return this._ensure(key, bucket).hit(title, this.hitCount, this.openHitsCount);
}

Profiler.prototype.end = function(hit, lastMessage)
{
	const target = this.targetMap[hit.bucket + "*" + hit.key];
	if(!target)
	{
		return;
	}
	target.done(hit, lastMessage, this.hitCount, this.openHitsCount);
	--this.openHitsCount;

	this.dataCollector.feed(target.getStats(), hit);
}

Profiler.prototype.reset = function()
{
	this.targetMap = {};
	this.hitCount = 0;

	this.dataCollector.reset();
}

Profiler.prototype._ensure = function(key, bucket)
{
	let target = this.targetMap[bucket + "*" + key];
	if(!target)
	{
		target = new ProfilerTarget(bucket, key);
		this.targetMap[bucket + "*" + key] = target;
	}
	return target;
}

Profiler.osResourceStats =
{
	avgCpu10sec: 0,
	avgCpu1min: 0,
	avgCpu5min: 0,
	avgCpu15min: 0,

	psCpuUsage: process.cpuUsage ? process.cpuUsage() : {system: 0, user: 0},
	psMemUsage: process.memoryUsage(),

	psUptime: process.uptime(),
	osUptime: os.uptime(),
};

function _startCpuMonitoring()
{
	const getAvgUsage = function(snapshot1, snapshot2)
	{
		let total = 0;
		for(let length = snapshot1.length, i = 0; i < length; ++i)
		{
			const item1 = snapshot1[i];
			const item2 = snapshot2[i];

			const idleDifference = item2.idle - item1.idle;
			const busyDifference = item2.busy - item1.busy;

			total += 100 - ~~(100 * idleDifference / busyDifference);  //  ~~ is a faster Math.floor
		}
		return (Math.floor(total * 100 / snapshot1.length) / 100);
	}

	const maxTimeWindowMs = 15 * 60 * 1000;       //  15 min
	const resolutionMs = 5 * 1000;                //   5 sec
	const snapshotHistorySize = Math.ceil(maxTimeWindowMs / resolutionMs) + 1;
	const snapshotHistory = Array(snapshotHistorySize).fill(null);
	const snapshotHistoryLastIndex = snapshotHistory.length - 1;
	let snapshotHistoryFirstIndex = snapshotHistoryLastIndex;

	setInterval(function()
	{
		const snapshot = MachineStats.getOsCpusUsage();
		snapshotHistory.push(snapshot);
		snapshotHistory.shift();

		if(snapshotHistoryFirstIndex != snapshotHistoryLastIndex)
		{
			let timeWindowMs, snapshotHistoryIndex;
			timeWindowMs =      10 * 1000; snapshotHistoryIndex = Math.max(snapshotHistoryLastIndex - Math.ceil(timeWindowMs / resolutionMs), snapshotHistoryFirstIndex); const lastSnapshot_10sec = snapshotHistory[snapshotHistoryIndex];
			timeWindowMs =      60 * 1000; snapshotHistoryIndex = Math.max(snapshotHistoryLastIndex - Math.ceil(timeWindowMs / resolutionMs), snapshotHistoryFirstIndex); const lastSnapshot_1min  = snapshotHistory[snapshotHistoryIndex];
			timeWindowMs =  5 * 60 * 1000; snapshotHistoryIndex = Math.max(snapshotHistoryLastIndex - Math.ceil(timeWindowMs / resolutionMs), snapshotHistoryFirstIndex); const lastSnapshot_5min  = snapshotHistory[snapshotHistoryIndex];
			timeWindowMs = 15 * 60 * 1000; snapshotHistoryIndex = Math.max(snapshotHistoryLastIndex - Math.ceil(timeWindowMs / resolutionMs), snapshotHistoryFirstIndex); const lastSnapshot_15min = snapshotHistory[snapshotHistoryIndex];

			Profiler.osResourceStats.avgCpu10sec = lastSnapshot_10sec ? getAvgUsage(lastSnapshot_10sec, snapshot) : 0;
			Profiler.osResourceStats.avgCpu1min  = lastSnapshot_1min ? getAvgUsage(lastSnapshot_1min, snapshot) : 0;
			Profiler.osResourceStats.avgCpu5min  = lastSnapshot_5min ? getAvgUsage(lastSnapshot_5min, snapshot) : 0;
			Profiler.osResourceStats.avgCpu15min = lastSnapshot_15min ? getAvgUsage(lastSnapshot_15min, snapshot) : 0;
		}

		//console.log(911, "10 sec", Profiler.osResourceStats.avgCpu10sec + "%");
		//console.log(911, "1 min", Profiler.osResourceStats.avgCpu1min + "%");
		//console.log(911, "5 min", Profiler.osResourceStats.avgCpu5min + "%");
		//console.log(911, "15 min", Profiler.osResourceStats.avgCpu15min + "%");

		Profiler.osResourceStats.psUptime = process.uptime();
		Profiler.osResourceStats.osUptime = os.uptime();
		Profiler.osResourceStats.psCpuUsage = process.cpuUsage ? process.cpuUsage() : {system: 0, user: 0};
		Profiler.osResourceStats.psMemUsage = process.memoryUsage();

		if(snapshotHistoryFirstIndex > 0) --snapshotHistoryFirstIndex;
	}, resolutionMs);
}
//#endregion

//#region ProfilerTarget
function ProfilerTarget(bucket, key)
{
	this.bucket = bucket || "";
	this.key = key;
	this.stats =
	{
		hitCount: 0,
		count: 0,
		minNs: Number.MAX_SAFE_INTEGER,         //  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/MAX_SAFE_INTEGER
		maxNs: 0,
		maxDateTime: new Date(),
		avgNs: 0,
		totalMs: 0,
		avgCpu: 0,
		minAvgOsCpu: 100,      //   based on rofiler.osResourceStats 1 minute stats, taken at the end of the hit
		maxAvgOsCpu: 0,        //   based on rofiler.osResourceStats 1 minute stats, taken at the end of the hit
		avgAvgOsCpu: 0,        //   based on rofiler.osResourceStats 1 minute stats, taken at the end of the hit
	};
}

ProfilerTarget.prototype.getStats = function()
{
	const result = {};

	result.bucket = this.bucket;
	result.key = this.key;

	result.count = this.stats.count;
	result.discrepancy = this.stats.hitCount - this.stats.count;

	result.minNs = this.stats.minNs;
	result.minMs = Math.round(this.stats.minNs / 1000000);

	result.maxNs = this.stats.maxNs;
	result.maxMs = Math.round(this.stats.maxNs / 1000000);
	result.maxDateTime = this.stats.maxDateTime;

	result.avgNs = this.stats.avgNs;
	result.avgMs = Math.round(this.stats.avgNs / 1000000);

	result.totalMs = this.stats.totalMs;
	result.totalSec = Math.round(this.stats.totalMs / 1000);

	result.avgCpu = Math.round(this.stats.avgCpu);
	result.minAvgOsCpu = Math.round(this.stats.minAvgOsCpu);
	result.avgAvgOsCpu = Math.round(this.stats.avgAvgOsCpu);
	result.maxAvgOsCpu = Math.round(this.stats.maxAvgOsCpu);

	return result;
};

ProfilerTarget.prototype.hit = function(title, hitCount, openHitsCount)
{
	++this.stats.hitCount;

	return {
		index: hitCount,
		localIndex: this.stats.hitCount - 1,
		openHitsCount: openHitsCount,
		bucket: this.bucket,
		key: this.key,
		title: title,
		time: new Date(),
		hrtime: process.hrtime(),
		currentHitStats: null,
		machineStats: MachineStats.hit(),
		currentMachineStats: null,
	};
};

ProfilerTarget.prototype.done = function(hit, lastMessage, hitCount, openHitsCount)
{
	if(!hit || !hit.hrtime || hit.hrtime.length != 2)
	{
		console.error(39991, "ProfilerTarget.done: Invalid argument hit: " + String(hit));
		return;
	}

	const hrtimespan = process.hrtime(hit.hrtime);
	const ns = _hrtimeToNs(hrtimespan);

	++this.stats.count;

	this.stats.minNs = Math.min(ns, this.stats.minNs);
	this.stats.maxNs = Math.max(ns, this.stats.maxNs);
	if(this.stats.maxNs == ns)
	{
		this.stats.maxDateTime = hit.time;
	}

	//  https://ubuntuincident.wordpress.com/2012/04/25/calculating-the-average-incrementally/
	this.stats.avgNs = this.stats.avgNs + (ns - this.stats.avgNs) / this.stats.count;

	this.stats.totalMs += Math.round(ns / 1000000);

	//  machine stats
	hit.currentMachineStats = MachineStats.done(hit.machineStats);

	//  https://ubuntuincident.wordpress.com/2012/04/25/calculating-the-average-incrementally/
	this.stats.avgCpu = this.stats.avgCpu + (hit.currentMachineStats.osMaxCpu - this.stats.avgCpu) / this.stats.count;

	this.stats.minAvgOsCpu = Math.min(hit.currentMachineStats.osAvgLoad_end, this.stats.minAvgOsCpu);
	this.stats.maxAvgOsCpu = Math.max(hit.currentMachineStats.osAvgLoad_end, this.stats.maxAvgOsCpu);
	//  https://ubuntuincident.wordpress.com/2012/04/25/calculating-the-average-incrementally/
	this.stats.avgAvgOsCpu = this.stats.avgAvgOsCpu + (hit.currentMachineStats.osAvgLoad_end - this.stats.avgAvgOsCpu) / this.stats.count;

	hit.currentHitStats =
	{
		diffIndex: hitCount - hit.index,
		hitIndex: hit.index,
		doneIndex: hitCount,
		diffLocalIndex: this.stats.count - 1 - hit.localIndex,
		hitLocalIndex: hit.localIndex,
		doneLocalIndex: this.stats.count - 1,
		diffOpenHitsCount: openHitsCount - hit.openHitsCount,
		hitOpenHitsCount: hit.openHitsCount,
		doneOpenHitsCount: openHitsCount,

		hrtimespan: hrtimespan,
		ns: ns,
		ms: Math.round(ns / 1000000),
		avgCpu: hit.currentMachineStats.osMaxCpu,
	};

	if(lastMessage)
	{
		hit.title += lastMessage;
	}
};
//#endregion

//#region MachineStats
function MachineStats()
{
}

MachineStats.hit = function()
{
	return MachineStats.getSnapshot();
}

MachineStats.done = function(hit)
{
	const snapshot = MachineStats.getSnapshot(hit.hrtime);

	const result =
	{
		timeNs: snapshot.hrtime,
		timeMs: Math.round(snapshot.hrtime / 1000000),

		psUptime: snapshot.psUptime,
		psCpuUsage: 0,
		psCpuUsage_kernel: 0,
		psCpuUsage_application: 0,
		psMemUsage_begin: 0,
		psMemUsage_end: 0,
		psMemUsage_delta: 0,

		osUptime: snapshot.osUptime,
		osAvgLoad_begin: hit.osAvgLoad,
		osAvgLoad_end: snapshot.osAvgLoad,
		osAvgLoad5min_begin: hit.osAvgLoad5min,
		osAvgLoad5min_end: snapshot.osAvgLoad5min,
		osAvgLoad15min_begin: hit.osAvgLoad15min,
		osAvgLoad15min_end: snapshot.osAvgLoad15min,
		osCpusUsage: [],
		osMaxCpu: 0,
		osMemUsage_begin: 0,
		osMemUsage_end: 0,
		osMemUsage_delta: 0,
	};

	//  ps cpu usage
	const time_micros = Math.round(snapshot.hrtime / 1000);
	const deltaKernelBusy_micros = snapshot.psCpuUsage.system - hit.psCpuUsage.system;
	result.psCpuUsage_kernel = ~~(100 * deltaKernelBusy_micros / time_micros);  //  ~~ is a faster Math.floor
	const deltaUserBusy_micros = snapshot.psCpuUsage.user - hit.psCpuUsage.user;
	result.psCpuUsage_application = ~~(100 * deltaUserBusy_micros / time_micros);  //  ~~ is a faster Math.floor
	result.psCpuUsage = result.psCpuUsage_kernel + result.psCpuUsage_application;

	//  ps mem usage
	result.psMemUsage_begin = ~~(100 * snapshot.psMemUsage.heapUsed / snapshot.psMemUsage.heapTotal);  //  ~~ is a faster Math.floor
	result.psMemUsage_end = ~~(100 * hit.psMemUsage.heapUsed / hit.psMemUsage.heapTotal);  //  ~~ is a faster Math.floor
	result.psMemUsage_delta = result.psMemUsage_end - result.psMemUsage_begin;

	//  os cpu usage
	for(let length = hit.osCpusUsage.length, i = 0; i < length; ++i)
	{
		const item1 = hit.osCpusUsage[i];
		const item2 = snapshot.osCpusUsage[i];

		const idleDifference = item2.idle - item1.idle;
		const busyDifference = item2.busy - item1.busy;

		const resultItem = 100 - ~~(100 * idleDifference / busyDifference);  //  ~~ is a faster Math.floor
		result.osCpusUsage.push(resultItem);

		result.osMaxCpu = Math.max(result.osMaxCpu, resultItem);
	}

	//  os mem usage
	result.osMemUsage_begin = 100 - ~~(100 * snapshot.osMemUsage.free / snapshot.osMemUsage.total);  //  ~~ is a faster Math.floor
	result.osMemUsage_end = 100 - ~~(100 * hit.osMemUsage.free / hit.osMemUsage.total);  //  ~~ is a faster Math.floor
	result.osMemUsage_delta = result.osMemUsage_end - result.osMemUsage_begin;

	return result;
}

MachineStats.getSnapshot = function(hrtime)
{
	return {
		hrtime: process.hrtime(hrtime),

		psUptime: Profiler.osResourceStats.psUptime,
		psCpuUsage: Profiler.osResourceStats.psCpuUsage,
		psMemUsage: Profiler.osResourceStats.psMemUsage,

		osUptime: Profiler.osResourceStats.osUptime,
		osAvgLoad: Profiler.osResourceStats.avgCpu1min,
		osAvgLoad5min: Profiler.osResourceStats.avgCpu5min,
		osAvgLoad15min: Profiler.osResourceStats.avgCpu15min,
		osCpusUsage: MachineStats.getOsCpusUsage(),
		osMemUsage:
		{
			free: os.freemem(),
			total: os.totalmem(),
		},
	};
}

MachineStats.getOsCpusUsage = function()
{
	const result = [];
	const osCpus = os.cpus();

	for(let length = osCpus.length, i = 0; i < length; ++i)
	{
		const cpu = osCpus[i];
		const item =
		{
			busy: 0,
			idle: cpu.times.idle,
		};
		for(const type in cpu.times)
		{
			item.busy += cpu.times[type];
		}
		result.push(item);
	}

	return result;
}
//#endregion

//#region Configuration
function Configuration(par)
{
	this.path = par.path;
	this.refreshSilenceTimeoutMs = par.refreshSilenceTimeoutMs || 5000;
	this.defaults = par.defaults;

	this.isRefreshing = false;
	this.lastRefreshTime = null;
	this.validFileChangedTime = null;

	this.useDefaults();
}

Configuration.prototype.useDefaults = function()
{
	this.sortColumn = this.defaults.sortColumn;
	this.verbosity = this.defaults.verbosity;
	this.bucketSettings = this.defaults.bucketSettings;
	this.archiveFullPath = this.defaults.archiveFullPath;
}

Configuration.prototype.smartRefresh = function()
{
	if(this.isRefreshing)
	{
		return;
	}
	if(this.lastRefreshTime && new Date().getTime() - this.lastRefreshTime.getTime() < this.refreshSilenceTimeoutMs)
	{
		return;
	}
	this.isRefreshing = true;

	return this._reload(function()
	{
		this.lastRefreshTime = new Date();
		this.isRefreshing = false;
	}.bind(this));
}

Configuration.prototype.isBucketEnabled = function(bucketKey)
{
	if(!this.bucketSettings)
	{
		return true;
	}
	const bucketConfig = this.bucketSettings[bucketKey];
	return !(bucketConfig && bucketConfig.enabled === false);
}

Configuration.prototype.getBucketSortColumn = function(bucketKey)
{
	if(!this.bucketSettings)
	{
		return this.sortColumn;
	}
	const bucketConfig = this.bucketSettings[bucketKey];
	if(!bucketConfig)
	{
		return this.sortColumn;
	}
	return bucketConfig[configField_sortColumn] || this.sortColumn;
}

Configuration.prototype._reload = function(callback)
{
	let stats;
	let json;
	return async.waterfall(
	[
		function(next)
		{
			return fs.stat(this.path, function(err, stats)
			{
				if(err)
				{
					return next(true);
				}
				return next(null, stats);
			});
		}.bind(this),
		function(result, next)
		{
			stats = result;
			if(this.validFileChangedTime && stats.mtime.getTime() == this.validFileChangedTime.getTime())
			{
				return next(true);
			}

			return fs.readFile(this.path, "utf8", next);
		}.bind(this),
		function(result, next)
		{
			json = result;
			this.validFileChangedTime = stats.mtime;

			if(!json || !json.trim || !json.trim())
			{
				//  no preferences
				return next(true);
			}

			try
			{
				this._readPreferences(JSON.parse(json));
				return next();
			}
			catch (ex)
			{
				console.log(236851, "[raw-profiler]", "Error in preferences JSON (file path \"" + this.path + "\"): ", ex);
				return next(true);
			}

		}.bind(this),
	], function(err)
	{
		if(err === true)
		{
			return callback();
		}
		if(err)
		{
			console.log(2368501, "[raw-profiler]", "Error reading the preferences JSON (file path \"" + this.path + "\"): ", err);
		}
		return callback();
	}.bind(this));
}

Configuration.prototype._readPreferences = function(preferences)
{
	this.useDefaults();

	if(preferences[configField_sortColumn] && this.sortColumn != preferences[configField_sortColumn])
	{
		this.sortColumn = preferences[configField_sortColumn];
		console.log("[raw-profiler]", "Using default soring column \"" + this.sortColumn + "\"");
	}
	if(preferences[configField_verbosity] && this.verbosity != preferences[configField_verbosity])
	{
		this.verbosity = preferences[configField_verbosity];
		console.log("[raw-profiler]", "Using verbosity level \"" + this.verbosity + "\"");
	}
	if(preferences[configField_archivePath])
	{
		const archiveFullPath = path.resolve(HOME_DIRECTORY, preferences[configField_archivePath]);
		if(archiveFullPath != this.archiveFullPath)
		{
			try
			{
				stats = fs.statSync(archiveFullPath);
				if(this.archiveFullPath != archiveFullPath)
				{
					this.archiveFullPath = archiveFullPath;
					console.log("[raw-profiler]", "Using archive path \"" + this.archiveFullPath + "\"");
				}
			}
			catch(ex)
			{
				console.log(246281, "[raw-profiler]", "Cannot access archive path \"" + archiveFullPath + "\", will keep using the old setting \"" + (this.archiveFullPath || "(default)") + "\": ", ex);
			}
		}
	}
	if(preferences[configField_buckets] && JSON.stringify(this.bucketSettings) != JSON.stringify(preferences[configField_buckets]))
	{
		this.bucketSettings = preferences[configField_buckets];
		console.log("[raw-profiler]", "Using new bucket settings", this.bucketSettings);
	}
}
//#endregion

//#region DataCollector
function DataCollector(configuration)
{
	this.configuration = configuration;
	this.targetStatsMap = {};

	this.loggingWaiting = false;
	this.loggingCueue = [];

	//  configuration (specified with a __pfconfig call)
	this.logger = Profiler.ConsoleLogger;
}

DataCollector.prototype.config = function(par)
{
	this.logger = par.logger || Profiler.ConsoleLogger;
	this.logDelayMs = par.logDelayMs || DEFAULT_LOG_DELAY_MS;
}

DataCollector.prototype.feed = function(targetStats, hit)
{
	this.configuration.smartRefresh();

	if(!this.configuration.isBucketEnabled(hit.bucket))
	{
		return;
	}

	const key = hit.bucket + "*" + hit.key;
	this.targetStatsMap[key] =
	{
		bucket: hit.bucket,
		targetStats: targetStats,
	};

	this.loggingCueue.push(
	{
		hit: hit,
		stats: this._getStats(),
		logger: this.logger,
	});

	if(!this.loggingWaiting)
	{
		this.loggingWaiting = true;
		setTimeout(function()
		{
			this._tryFlushLoggingCueue.bind(this)(function done(err, result)
			{
				this.loggingWaiting = false;
				if(err)
				{
					console.log(2765501, "[raw-profiler]", "Error flushing collected data: ", err, err.stack);
				}
			}.bind(this));
		}.bind(this), this.logDelayMs);
	}
}

DataCollector.prototype.reset = function()
{
	this.targetStatsMap = {};
}


DataCollector.prototype._tryFlushLoggingCueue = function(callback)
{
	return async.whilst(
		function test(test_callback)
		{
			return test_callback(null, this.loggingCueue.length != 0);
		}.bind(this),
		function execute(next)
		{
			const item = this.loggingCueue.shift();
			if(!item)
			{
				return next();
			}
			return async.waterfall(
			[
				function(next)
				{
					return setImmediate(function() {return next()});
				}.bind(this),
				function(next)
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
				function(buckets, next)
				{
					return setImmediate(function() {return next(null, buckets)});
				}.bind(this),
				function(buckets, next)
				{
					return item.logger.logBuckets(item.hit.bucket, buckets, this.configuration, next);
				}.bind(this)
			], next);
		}.bind(this),
		callback
	);
}

DataCollector.prototype._getStats = function(ascending)
{
	ascending = !!ascending;

	const result = {};
	for(const key in this.targetStatsMap)
	{
		const item = this.targetStatsMap[key];
		let bucket = result[item.bucket];
		if(!bucket)
		{
			bucket = [];
			result[item.bucket] = bucket;
		}
		bucket.push(item.targetStats);
	}

	for (const bucketKey in result)
	{
		const bucket = result[bucketKey];
		const sortPropertyName = this.configuration.getBucketSortColumn(bucketKey);
		bucket.sort(function(left, right)
		{
			const leftValue = left[sortPropertyName];
			const rightValue = right[sortPropertyName];

			if((!leftValue && leftValue !== 0) || (!rightValue && rightValue !== 0))
			{
				console.log(634253, "[raw-profiler]", "Possibly wrong sort column name: \"" + sortPropertyName + "\", values: \"" + leftValue + "\", \"" + rightValue + "\"");
			}

			if(ascending)
			{
				return leftValue - rightValue;
			}

			return rightValue - leftValue;
		});
	}

	return result;
}


DataCollector.formatStats = function(stats, time, title, currentMachineStats, currentHitStats, currentHitKey, callback)
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

		if(currentMachineStats)
		{
			sb.push(DataCollector.formatMachineStats(currentMachineStats));
			sb.push('\n');
			sb.push(DataCollector.formatHitStats(currentHitStats));
		}

		headerBucket[EVerbosity.Brief] = sb.join("");
		headerBucket[EVerbosity.Full] = headerBucket.brief;

		return async.eachOfSeries(stats, function(bucket, bucketKey, next)
		{
			setImmediate(function()
			{
				try
				{
					result[bucketKey] = DataCollector.formatBucket(bucketKey, bucket, currentHitKey);
					return next();
				}
				catch(ex)
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
	catch(ex)
	{
		return callback(new Error(ex));
	}
}

DataCollector.formatMachineStats = function(machineStats)
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
	for(let length = machineStats.osCpusUsage.length, i = 0; i < length; ++i)
	{
		if(i)
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

DataCollector.formatHitStats = function(hitStats)
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
		sb.push(" │ ");
		sb.push(lpad(fields.hitLocalIndex, hitLocalIndexColSize, ' '));
		sb.push(" │ ");
		sb.push(lpad(fields.doneLocalIndex, doneLocalIndexColSize, ' '));
		sb.push(" │ ");
		sb.push(lpad(fields.diffIndex, diffIndexColSize, ' '));
		sb.push(" │ ");
		sb.push(lpad(fields.hitIndex, hitIndexColSize, ' '));
		sb.push(" │ ");
		sb.push(lpad(fields.doneIndex, doneIndexColSize, ' '));
		sb.push(" │ ");
		sb.push(lpad(fields.diffOpenHitsCount, diffOpenHitsCountColSize, ' '));
		sb.push(" │ ");
		sb.push(lpad(fields.hitOpenHitsCount, hitOpenHitsCountColSize, ' '));
		sb.push(" │ ");
		sb.push(lpad(fields.doneOpenHitsCount, doneOpenHitsCountColSize, ' '));
		sb.push(" │ ");
		sb.push(rpad(fields.duration, durationColSize, ' '));
		sb.push(" │ ");
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

DataCollector.formatBucket = function(bucketKey, bucket, currentHitKey)
{
	function printStat(sb, stat, isCurrent)
	{
		let keyFieldWidth = 71;

		const discrepancy = parseInt(stat.discrepancy);
		if(!isNaN(discrepancy) && discrepancy != 0)
		{
			sb.push(rpad("!!!", 4, ' '));
		}
		else
		{
			keyFieldWidth += 4;
		}

		if(stat.bucketKey)
		{
			keyFieldWidth -= stat.bucketKey.length + 2;
			sb.push("[" + stat.bucketKey + "]");
		}

		if(isCurrent)
		{
			sb.push(erpad("> " + stat.key, keyFieldWidth));
		}
		else
		{
			sb.push(erpad(stat.key, keyFieldWidth));
		}
		sb.push(' │ ');
		sb.push(lpad(stat.count, 5, ' '));
		sb.push(' │ ');
		sb.push(lpad(stat.discrepancy, 2, ' '));
		sb.push(' │ ');
		sb.push(elpad(stat.minMs + "ms", 10, ' '));
		sb.push(' │ ');
		sb.push(elpad(stat.avgMs + "ms", 10, ' '));
		sb.push(' │ ');
		sb.push(elpad(stat.maxMs + "ms", 10, ' '));
		sb.push(' │ ');
		if(stat.totalSec > 0)
		{
			sb.push(elpad(stat.totalSec + "s", 7, ' '));
		}
		else
		{
			sb.push(elpad(stat.totalMs + "ms", 7, ' '));
		}
		sb.push(' │ ');
		sb.push(fdate(stat.maxDateTime));
		sb.push(' │ ');
		sb.push(lpad(stat.avgCpu + "%", 4, ' '));
		sb.push(' │ ');
		sb.push(lpad(stat.minAvgOsCpu + "%", 7, ' '));
		sb.push(' │ ');
		sb.push(lpad(stat.avgAvgOsCpu + "%", 7, ' '));
		sb.push(' │ ');
		sb.push(lpad(stat.maxAvgOsCpu + "%", 7, ' '));
		sb.push(' │ ');
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

	for(let length = bucket.length, i = 0; i < length; ++i)
	{
		const item = bucket[i];

		printStat(sb, item, currentHitKey == item.key);
		sb.push('\n');

		if(currentHitKey == item.key)
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
//#endregion

//#region DataCollectorServer
function DataCollectorServer(par, configuration)
{
	this.configuration = configuration;
	this.host = par.host;
	this.port = par.port;

	this.logDirectory = par.logDirectory;
	this.maxLogSizeBytes = par.maxLogSizeBytes || 200 * 1024 * 1024;            //  200Mb
	this.maxArchiveSizeBytes = par.maxArchiveSizeBytes || 1024 * 1024 * 1024;   //  1Gb
	this.logDelayMs = par.logDelayMs || DEFAULT_LOG_DELAY_MS;
	this.logRequestArchivingModulo = par.logRequestArchivingModulo || 100;

	this.dataCollectors = {};
}

DataCollectorServer.prototype.run = function(par)
{
	const getSourceCallback = par ? par.getSourceCallback : null;

	const uncaughtExceptionFunc = function ( err, data )
	{
		console.log( "[raw-profiler]", "--- EXCEPTION ---" );
		console.log( "[raw-profiler]", err );
		console.log( "[raw-profiler]", err.stack || err.message );
		console.log( "[raw-profiler]", data );
	};
	process.on( 'uncaughtException', uncaughtExceptionFunc );

	const express = require( 'express');
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

	app.post('/feed', function (req, res)
	{
		let source;
		if(getSourceCallback)
		{
			source = getSourceCallback(req, res) || "";
		}
		else
		{
			const connection = req.connection || {};
			const socket = req.socket || connection.socket || {};
			source = connection.remoteAddress || socket.remoteAddress || "";
		}
		source = source.replace(/\D/g, '.');
		if(req.body.sourceName)
		{
			const strippedSourceName = req.body.sourceName.replace(/([^a-z0-9_\-]+)/gi, "-");
			source += "-" + strippedSourceName;
		}
		this._ensureDataCollector(source).feed(req.body.targetStats, req.body.hit);
		res.end("");
	}.bind(this));

	console.log("[raw-profiler]", "Data collector server listenig on " + this.host + ":" + this.port);
	app.listen(this.port, this.host);
}

DataCollectorServer.prototype._ensureDataCollector = function(source)
{
	const dataCollector = this.dataCollectors[source];
	if(!dataCollector)
	{
		const fileLogger = new FileLogger(
		{
			source: source,
			maxLogSizeBytes: this.maxLogSizeBytes,
			maxArchiveSizeBytes: this.maxArchiveSizeBytes,
			logDirectory: this.logDirectory,
			logRequestArchivingModulo: this.logRequestArchivingModulom,
		});
		dataCollector = new DataCollector(this.configuration);
		dataCollector.config({logger: fileLogger, logDelayMs: this.logDelayMs});
		this.dataCollectors[source] = dataCollector;
	}

	return dataCollector;
}
//#endregion

//#region DataCollectorHttpProxy
function DataCollectorHttpProxy(uri, sourceName, configuration)
{
	this.uri = uri;
	this.sourceName = sourceName;
	this.configuration = configuration;

	this.requestTimeoutMs = 2000;

	this.failureCounter = 0;
	this.failureTime = null;
	this.failureTimeoutMs = 15 * 1000;

	console.log("[raw-profiler]", "Feeding data to " + this.uri);
}

DataCollectorHttpProxy.prototype.config = function(par)
{
	this.requestTimeoutMs = par.requestTimeoutMs || this.requestTimeoutMs;
}

DataCollectorHttpProxy.prototype.feed = function(targetStats, hit)
{
	this.configuration.smartRefresh();

	setImmediate(() =>
	{
		const start = new Date();
		const fetch = require("node-fetch");
		fetch(
			this.uri,
			{
				method: "POST",
				timeout: this.requestTimeout,
				headers: {
					"Content-Type": 'application/json'
				},
				body: JSON.stringify({
					targetStats,
					hit,
					sourceName: this.sourceName,
				}),
			}
		)
		.then(response =>
		{
			if (!response.ok || response.text())
			{
				const end = new Date();
				const durationMs = end.getTime() - start.getTime();

				this.failureCounter++;
				if (!this.failureTime || new Date().getTime() - this.failureTime.getTime() >= this.failureTimeoutMs)
				{
					this.failureTime = new Date();
					console.log(49576325, "[raw-profiler]", error || body, "" + this.failureCounter + " feed(s) lost. Failing request took " + durationMs + "ms.");
				}
			}
			else
			{
				if (this.failureCounter)
				{
					console.log(49576326, "[raw-profiler]", "" + this.failureCounter + " feed(s) lost. Now resuming normal operation.");
					this.failureCounter = 0;
				}
			}
		});
	});
}

DataCollectorHttpProxy.prototype.reset = function()
{
	//  do nothing
}
//#endregion

//#region FileLogger
function FileLogger(par)
{
	par = par || {};
	this.logDirectory = par.logDirectory || FILE_LOGGER_DIRECTORY;
	this.source = par.source || "";
	this.maxLogSizeBytes = par.maxLogSizeBytes || 0;
	this.maxArchiveSizeBytes = par.maxArchiveSizeBytes || 0;
	this.logRequestArchivingModulo = par.logRequestArchivingModulo || 25;

	this.archiveStamper = lpad(new Date().getTime(), 14, '0');
	this.archivingInProgressCount = 0;

	this.logRequestCounter = 0;
}

FileLogger.prototype.logBuckets = function(currentBucketKey, buckets, configuration, callback)
{
	try
	{
		const verbosity = configuration.verbosity;

		const logsDirectory = path.resolve(HOME_DIRECTORY, this.logDirectory, this.source);
		const headerBucket = buckets["header"];
		if(!headerBucket)
		{
			throw "ASSERTION FAILED: headerBucket";
		}
		const currentBucket = buckets[currentBucketKey];
		if(!currentBucket)
		{
			throw "ASSERTION FAILED: currentBucket";
		}

		const snapshotFileName = currentBucketKey + ".now";
		const snapshotFilePath = path.join(logsDirectory, snapshotFileName);

		const prefix = this.maxLogSizeBytes ? this.archiveStamper + "-" : "";
		const logFileName = prefix + currentBucketKey + ".log";
		const logFilePath = path.join(logsDirectory, logFileName);

		return async.series(
		[
			function(next)
			{
				return fs.access(logsDirectory, function(err, result)
				{
					if(err)
					{
						return fs.mkdir(logsDirectory, next);
					}
					return next();
				});
			},
			function(next)
			{
				if(headerBucket[EVerbosity.Full]) return fs.writeFile(snapshotFilePath, headerBucket[EVerbosity.Full], next);
				else return next();
			},
			function(next)
			{
				if(currentBucket[EVerbosity.Full]) return fs.appendFile(snapshotFilePath, "\n" + currentBucket[EVerbosity.Full], next);
				else return next();
			},
			function(next)
			{
				if(headerBucket[verbosity]) return fs.appendFile(logFilePath, "\n" + headerBucket[verbosity], next);
				else return next();
			},
			function(next)
			{
				if(currentBucket[verbosity]) return fs.appendFile(logFilePath, "\n" + currentBucket[verbosity], next);
				else return next();
			},
			function(next)
			{
				if(this.logRequestCounter % this.logRequestArchivingModulo == 0)
				{
					return this._tryArchiveLogFiles(buckets, configuration, next);
				}
				else return next();
			}.bind(this),
			function(next)
			{
				++this.logRequestCounter;
				return next();
			}.bind(this)
		], callback);
	}
	catch(ex)
	{
		return callback(new Error(ex));
	}
}

FileLogger.prototype._listOrphanedLogFiles = function(callback)
{
	try
	{
		const result = [];

		if(!this.maxLogSizeBytes)
		{
			return callback(null, result);
		}

		const logsDirectory = path.resolve(HOME_DIRECTORY, this.logDirectory, this.source);
		const prefix = this.archiveStamper + "-";

		return async.waterfall(
		[
			function(next)
			{
				return fs.readdir(logsDirectory, next);
			},
			function(entries, next)
			{
				return async.eachSeries(entries, function(item, itemNext)
				{
					const fullPath = path.join(logsDirectory, item);
					return fs.stat(fullPath, function(err, stats)
					{
						if(stats.isDirectory())
						{
							return itemNext();
						}
						if(item.indexOf(prefix) != -1)
						{
							return itemNext();
						}
						if(path.extname(item) != ".log")
						{
							return itemNext();
						}
						result.push(fullPath);
						return itemNext();
					});
				}, next);
			}
		], function(err)
		{
			return callback(err, result);
		});
	}
	catch(ex)
	{
		return callback(new Error(ex));
	}
}

FileLogger.prototype._getCurrentLogFilesInfo = function(callback)
{
	try
	{
		const result =
		{
			logFiles: [],
			totalLogSize: 0,
		};

		if(!this.maxLogSizeBytes)
		{
			return callback(result);
		}

		const logsDirectory = path.resolve(HOME_DIRECTORY, this.logDirectory, this.source);
		const prefix = this.archiveStamper + "-";

		return async.waterfall(
		[
			function(next)
			{
				return fs.readdir(logsDirectory, next);
			},
			function(entries, next)
			{
				return async.eachSeries(entries, function(item, itemNext)
				{
					const fullPath = path.join(logsDirectory, item);
					return fs.stat(fullPath, function(err, stats)
					{
						if(stats.isDirectory())
						{
							return itemNext();
						}
						const extension = path.extname(item);
						if(extension != ".log" && extension != ".now")
						{
							return itemNext();
						}
						if(extension == ".log" && item.indexOf(prefix) == -1)
						{
							return itemNext();
						}
						result.logFiles.push(fullPath);
						result.totalLogSize += stats.size;
						return itemNext();
					});
				}, next);
			}
		], function(err)
		{
			return callback(err, result);
		});
	}
	catch(ex)
	{
		return callback(new Error(ex));
	}
}

FileLogger.prototype._getArchiveFilesInfo = function(archiveDirectory, callback)
{
	try
	{
		const result =
		{
			archiveFiles: [],
			totalArchiveSize: 0,
		};

		if(!this.maxLogSizeBytes)
		{
			return callback(null, result);
		}

		return async.waterfall(
		[
			function(next)
			{
				return fs.readdir(archiveDirectory, next);
			},
			function(entries, next)
			{
				return async.eachSeries(entries, function(item, itemNext)
				{
					const fullPath = path.join(archiveDirectory, item);
					return fs.stat(fullPath, function(err, stats)
					{
						//	TODO: delete commets
						//const fullPath = path.join(archiveDirectory, item);
						//const stats = fs.statSync(fullPath);
						if(stats.isDirectory())
						{
							return itemNext();
						}
						const extension = path.extname(item);
						if(extension != ".zip")
						{
							return itemNext();
						}
						result.archiveFiles.push(
						{
							fullPath: fullPath,
							size: stats.size,
							mtime: stats.mtime,
						});
						return itemNext();
					});
				}, next);
			}
		], function(err)
		{
			return callback(err, result);
		});
	}
	catch(ex)
	{
		return callback(new Error(ex));
	}
}

FileLogger.prototype._archiveLogFiles = function(logFiles, archiveName, callback)
{
	this.archivingInProgressCount++;

	const output = fs.createWriteStream(archiveName);
	const archive = archiver('zip');
	archive.on("error", function(err)
	{
		console.log(6346135, "[raw-profiler]", "Error creating a profiling log archive", err);
	});
	output.on("close", function()
	{
		console.log("[raw-profiler]", "Deleting old log files... ");
		for(let length = logFiles.length, i = 0; i < length; ++i)
		{
			try
			{
				const item = logFiles[i];
				if(path.extname(item) == ".now")
				{
					continue;
				}
				fs.unlinkSync(item);
			}
			catch(ex)
			{
				console.log(28376423, "[raw-profiler]", "Error deleting old profiling log file \"" + logFiles[i] + "\"", ex);
			}
		}
		this.archivingInProgressCount--;
		if(!this.archivingInProgressCount)
		{
			return callback();
		}
	}.bind(this));

	archive.pipe(output);

	for(let length = logFiles.length, i = 0; i < length; ++i)
	{
		const item = logFiles[i];
		try
		{
			archive.append(fs.createReadStream(item), {name: path.basename(item)});
		}
		catch(ex)
		{
			console.log(83647223, "[raw-profiler]", "Error appending profiling log file \"" + logFiles[i] + "\" to archive", ex);
		}
	}

	archive.finalize();
}

FileLogger.prototype._getArchiveDirectory = function(configuration, callback)
{
	try
	{
		const logsDirectory = path.resolve(HOME_DIRECTORY, this.logDirectory, this.source);
		const archiveDirectory = logsDirectory;
		const archiveFullPath = configuration.archiveFullPath;
		if(archiveFullPath)
		{
			try
			{
				archiveDirectory = path.join(archiveFullPath, this.source);
				if(!fs.existsSync(archiveDirectory))
				{
					fs.mkdirSync(archiveDirectory);
				}
			}
			catch(ex)
			{
				console.log(85647228, "[raw-profiler]", "Cannot access the configured archive path \"" + archiveDirectory + "\", will use the default archive directory \"" + logsDirectory + "\"", ex);
				archiveDirectory = logsDirectory;
			}
		}
		return setImmediate(function() {callback(null, archiveDirectory)});
	}
	catch(ex)
	{
		return callback(new Error(ex));
	}
}

FileLogger.prototype._tryArchiveLogFiles = function(buckets, configuration, callback)
{
	try
	{
		if(!this.maxLogSizeBytes)
		{
			return callback();
		}

		if(this.archivingInProgressCount)
		{
			return callback();
		}

		const archivingFinishedCallback = function()
		{
			//  no callback is intentional - we don't care when archiving ends
			return async.waterfall(
			[
				function(next)
				{
					return this._getArchiveFilesInfo(archiveDirectory, next);
				}.bind(this),
				function(archiveFilesInfo, next)
				{
					if(archiveFilesInfo.totalArchiveSize >= this.maxArchiveSizeBytes)
					{
						console.log("[raw-profiler]", "Total archive size is now " + (Math.round(100 * archiveFilesInfo.totalArchiveSize / (1024 * 1024)) / 100) + "Mb and exceeds the maximun archive size setting: " + (Math.round(100 * this.maxArchiveSizeBytes / (1024 * 1024)) / 100) + "Mb");
						console.log("[raw-profiler]", "Deleting oldest archive files...");

						archiveFilesInfo.archiveFiles.sort(function(left, right)
						{
							return left.mtime.getTime() - right.mtime.getTime();
						});

						const delta = archiveFilesInfo.totalArchiveSize - this.maxArchiveSizeBytes;
						let cumulativeSize = 0;
						const filesToRemove = [];
						for(let length = archiveFilesInfo.archiveFiles.length, i = 0; i < length; ++i)
						{
							const item = archiveFilesInfo.archiveFiles[i];
							cumulativeSize += item.size;
							if(cumulativeSize >= delta)
							{
								break;
							}
							filesToRemove.push(item.fullPath);
						}

						return asynch.each(filesToRemove, function(item, itemNext)
						{
							try
							{
								return fs.unlink(item, itemNext);
							}
							catch(ex)
							{
								console.log(28376423, "[raw-profiler]", "Error deleting old archive file \"" + item + "\"", ex);
								return itemNext();
							}
						}, next);
					}

					console.log("[raw-profiler]", "Done.");
				}
			], function(err)
			{
				console.log(28376423, "[raw-profiler]", err, err.stack);
			});
		}.bind(this);

		this.archivingInProgressCount++;
		let archiveDirectory;
		return async.waterfall(
		[
			function(next)
			{
				return this._getArchiveDirectory(configuration, next);
			}.bind(this),
			function(result, next)
			{
				archiveDirectory = result;
				return this._listOrphanedLogFiles(next);
			}.bind(this),
			function(orphanedLogList, next)
			{
				if(orphanedLogList.length)
				{
					const orphanedStamper = lpad(new Date().getTime(), 14, '0');
					const orphanedArchiveName = path.join(archiveDirectory, orphanedStamper + "-orphaned.zip");

					console.log("[raw-profiler]", "Archiving orphaned files to \"" + orphanedArchiveName + "\"...");

					//  intentionally forking the waterfall, there is no need to wait for the zip-process to finish
					this._archiveLogFiles(orphanedLogList, orphanedArchiveName, archivingFinishedCallback);
				}
				return next();
			}.bind(this),
			function(next)
			{
				return this._getCurrentLogFilesInfo(next);
			}.bind(this),
			function(currentLogInfo, next)
			{
				if(currentLogInfo.totalLogSize >= this.maxLogSizeBytes)
				{
					const archiveName = path.join(archiveDirectory, this.archiveStamper + ".zip");

					console.log("[raw-profiler]", "Archiving a total of " + (Math.round(100 * currentLogInfo.totalLogSize / (1024 * 1024)) / 100) + "Mb of log files to \"" + archiveName + "\"...");

					//  from this point on the code will become asynchroneous, so we change the this.archiveStamper in order to redirect new logs to new files,
					//  while the old log files are being compressed, archived and eventually deleted
					this.archiveStamper = lpad(new Date().getTime(), 14, '0');

					//  intentionally forking the waterfall, there is no need to wait for the zip-process to finish
					this._archiveLogFiles(currentLogInfo.logFiles, archiveName, archivingFinishedCallback);
				}
				return next();
			}.bind(this)
		], function(err)
		{
			this.archivingInProgressCount--;
			return callback(err);
		}.bind(this));
	}
	catch(ex)
	{
		return callback(new Error(ex));
	}
}
//#endregion

//#region Utilities: hrtime
function _hrtimeToNs(hrtime)
{
	return hrtime[0] * 1000000000 + hrtime[1];
}

function _nsToHrtime(ns)
{
	const seconds = Math.floor(ns / 1000000000);
	const nanoseconds = ns - seconds * 1000000000;
	return [seconds, nanoseconds];
}
//#endregion

//#region Utilities: text formatting
function rep(count, character)
{
	const sb = new Array(count + 1);
	return sb.join(character);
}

function rpad(text, count, character)
{
	text = String(text);
	const sb = [];
	sb.push(text);
	if(count > text.length) sb.push(rep(count - text.length, character));
	return sb.join("");
}

function lpad(text, count, character)
{
	text = String(text);
	const sb = [];
	if(count > text.length) sb.push(rep(count - text.length, character));
	sb.push(text);
	return sb.join("");
}

function elpad(text, count)
{
	const ellipses = "...";
	if(count == text.length) return text;
	if(count < text.length)
	{
		return text.substr(0, count - ellipses.length) + ellipses;
	}
	return lpad(text, count, ' ');
}

function erpad(text, count)
{
	const ellipses = "...";
	if(count == text.length) return text;
	if(count < text.length)
	{
		return text.substr(0, count - ellipses.length) + ellipses;
	}
	return rpad(text, count, ' ');
}

function fdate(date)
{
	if(!date.getFullYear)
	{
		return elpad(date, 30);
	}

	const sb = [];
	sb.push(date.getFullYear());
	sb.push("-");
	sb.push(lpad(date.getMonth() + 1, 2, '0'));
	sb.push("-");
	sb.push(lpad(date.getDate(), 2, '0'));
	sb.push(" ");
	sb.push(lpad(date.getHours(), 2, '0'));
	sb.push(":");
	sb.push(lpad(date.getMinutes(), 2, '0'));
	sb.push(":");
	sb.push(lpad(date.getSeconds(), 2, '0'));
	sb.push(".");
	sb.push(lpad(date.getMilliseconds(), 3, '0'));

	const tz = Math.abs(date.getTimezoneOffset());
	const tzSign = date.getTimezoneOffset() < 0 ? "+" : "-";
	const tzHours = lpad(tz / 60, 2, '0');
	const tzMinutes = lpad(tz % 60, 2, '0');
	sb.push(" ");
	sb.push(tzSign);
	sb.push(tzHours);
	sb.push(":");
	sb.push(tzMinutes);

	return sb.join("");
}

function fduration(ms)
{
	const now = new Date();
	const timezoneOffsetMs = now.getTimezoneOffset() * 60 * 1000;
	const dateTime = new Date(ms + timezoneOffsetMs);
	const parts =
	[
		{postfix: " years ", value: dateTime.getFullYear() - 1970, padding: 4},
		{postfix: " months ", value: dateTime.getMonth(), padding: 2},
		{postfix: " days ", value: dateTime.getDate() - 1, padding: 2},
		{postfix: ":", value: dateTime.getHours(), padding: 2},
		{postfix: ":", value: dateTime.getMinutes(), padding: 2},
		{postfix: ".", value: dateTime.getSeconds(), padding: 2},
		{postfix: "ms", value: dateTime.getMilliseconds(), padding: 3},
	];

	const sb = [];

	let include = false;
	let includedPartCount = 0;
	for(let length = parts.length, i = 0; i < length; ++i)
	{
		const part = parts[i];
		if(!part.value && !include)
		{
			continue;
		}
		include = true;
		if(!includedPartCount)
		{
			sb.push(part.value);
		}
		else
		{
			sb.push(lpad(part.value, part.padding, '0'));
		}
		includedPartCount++;
		if(i != length - 1)
		{
			sb.push(part.postfix);
		}
	}

	if(includedPartCount == 1)
	{
		sb.push(parts[parts.length - 1].postfix);
	}

	return sb.join("");
}
//#endregion

//#region Interface
function _pfbegin(bucket, key, title)
{
	try
	{
		if(!_isEnabled(bucket))
		{
			return null;
		}

		return Profiler.instance.begin(bucket, key, title);
	}
	catch(ex)
	{
		console.log(3456348756, "[raw-profiler]", "Uncaught exception, please report to raw-profiler vendor", ex, ex.stack);
		return null;
	}
}

function _pfend(hit, lastMessage)
{
	try
	{
		if(!hit || !_isEnabled())
		{
			return;
		}

		Profiler.instance.end(hit, lastMessage);
	}
	catch(ex)
	{
		console.log(3456348757, "[raw-profiler]", "Uncaught exception, please report to raw-profiler vendor", ex, ex.stack);
	}
	return null;
}

function _pfconfig(config)
{
	try
	{
		Profiler.instance.config(config);
	}
	catch(ex)
	{
		console.log(3456348758, "[raw-profiler]", "Uncaught exception, please report to raw-profiler vendor", ex, ex.stack);
	}
}

function _isEnabled(bucketKey)
{
	try
	{
		const commandFileFullPath = path.join(HOME_DIRECTORY, COMMAND_FILE_NAME);

		try
		{
			fs.accessSync(commandFileFullPath, fs.F_OK);
			if(!bucketKey)
			{
				return true;
			}
			return Profiler.configuration.isBucketEnabled(bucketKey);
		}
		catch (ex)
		{
			return false;
		}
	}
	catch(ex)
	{
		console.log(3456348759, "[raw-profiler]", "Uncaught exception, please report to raw-profiler vendor", ex, ex.stack);
		return false;
	}
}


Profiler.configuration = new Configuration(
{
	path: path.join(HOME_DIRECTORY, configurationFileName),
	refreshSilenceTimeoutMs: configurationRefreshSilenceTimeoutMs,
	defaults:
	{
		sortColumn: defaultSortColumn,
		verbosity: defaultVerbosity,
		bucketSettings: null,
		archiveFullPath: null,
	}
});

Profiler.utility =
{
	getKeysText: function(obj)
	{
		try
		{
			const sb = []
			for (const key in obj)
			{
				sb.push(key);
			}
			return sb.join(',');
		}
		catch(ex)
		{
			console.log(3456348760, "[raw-profiler]", "Uncaught exception, please report to raw-profiler vendor", ex, ex.stack);
			return "";
		}
	},

	stripStringify: function(obj, stripFieldPaths)
	{
		try
		{
			if(!obj)
			{
				return JSON.stringify(obj);
			}

			if(obj instanceof Array)
			{
				return this.stripStringifyArray(obj, stripFieldPaths);
			}

			function _resolvePropertyPath(obj, pathText)
			{
				let parent = null;
				let key = null;
				let value = null;
				const path = pathText.split(".");
				for(let length = path.length, i = 0; i < length; ++i)
				{
					key = path[i];
					if(!obj.hasOwnProperty(key))
					{
						return null;
					}
					value = obj[key];
					if(i < length - 1 && !(value instanceof Object))
					{
						return null;
					}
					parent = obj;
					obj = value;
				}
				return {
					parent: parent,
					key: key,
					value: value,
				}
			}

			//const originalJson = JSON.stringify(obj);
			const original = [];
			for(let length = stripFieldPaths.length, i = 0; i < length; ++i)
			{
				const path = stripFieldPaths[i];
				const resolveInfo = _resolvePropertyPath(obj, path);
				if(!resolveInfo)
				{
					continue;
				}
				original[path] = resolveInfo;
				resolveInfo.parent[resolveInfo.key] = "(stripped by raw-profiler)";
			}
			const result = JSON.stringify(obj);
			for (const path in original)
			{
				const resolveInfo = original[path];
				resolveInfo.parent[resolveInfo.key] = resolveInfo.value;
			}
			//const finalJson = JSON.stringify(obj);
			//if(originalJson != finalJson)
			//{
			//	throw "ASSERTION FAILED: originalJson == finalJson";
			//}
			return result;
		}
		catch(ex)
		{
			console.log(3456348761, "[raw-profiler]", "Uncaught exception, please report to raw-profiler vendor", ex, ex.stack);
			return "";
		}
	},

	stripStringifyArray: function(arr, stripFieldPaths)
	{
		try
		{
			if(!arr || !arr.length)
			{
				return JSON.stringify(arr);
			}

			const sb = [];
			sb.push("[");
			for(let length = arr.length, i = 0; i < length; ++i)
			{
				if(i != 0)
				{
					sb.push(", ");
				}
				sb.push(this.stripStringify(arr[i], stripFieldPaths));
			}
			sb.push("]");
		}
		catch(ex)
		{
			console.log(3456348762, "[raw-profiler]", "Uncaught exception, please report to raw-profiler vendor", ex, ex.stack);
			return "";
		}
		return sb.join("");
	},
};

Profiler.ConsoleLogger =
{
	logBuckets: function consoleLogger(currentBucketKey, buckets, configuration, callback)
	{
		const verbosity = configuration.verbosity;

		const headerBucket = buckets["header"];
		const currentBucket = buckets[currentBucketKey];

		if(headerBucket[verbosity]) console.log(headerBucket[verbosity]);
		if(currentBucket[verbosity]) console.log(currentBucket[verbosity]);

		return callback();
	}
};

Profiler.enums =
{
	EVerbosity: EVerbosity,
};

Profiler.RootPath = HOME_DIRECTORY;

Profiler.FsLogger = new FileLogger();

Profiler.createDataCollectorHttpProxy = function(url, sourceName) {return new DataCollectorHttpProxy(url, sourceName, Profiler.configuration)};
Profiler.createDataCollectorServer = function(par) {return new DataCollectorServer(par, Profiler.configuration)};
Profiler.createFileLogger = function(par) {return new FileLogger(par)};

Profiler.instance = new Profiler(Profiler.configuration);
_startCpuMonitoring();

module.exports =
{
	globals()
	{
		global.__pf = Profiler;
		global.__pfconfig = _pfconfig;
		global.__pfenabled = _isEnabled;
		global.__pfbegin = _pfbegin;
		global.__pfend = _pfend;
	}
};
module.exports.__pf = Profiler;
module.exports.__pfconfig = _pfconfig;
module.exports.__pfenabled = _isEnabled;
module.exports.__pfbegin = _pfbegin;
module.exports.__pfend = _pfend;

//#endregion