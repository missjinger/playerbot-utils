var MAX_HISTORY_SIZE = 30;
var UPDATE_INTERVAL = 250;
var STALE_ITER_COUNT = 60 * 1000 / UPDATE_INTERVAL;
angular.module('monitoring', [])
.config(['$locationProvider', function($locationProvider) {
        $locationProvider.html5Mode(true);
}])
.filter('reverse', function() {
	return function(items) {
		return items.slice().reverse();
	};
})
.filter('unique', function() {
	return function(history) {
		var action;
		var result = [];
		for (var i = 0; i < history.length; i++) {
			if (history[i] != action) {
				action = history[i];
				result.push(history[i]);
			}
		}
		return result;
	};
})
.filter('onlyWithProblems', function() {
	return function(bots) {
		var result = [];
		for (var i = 0; i < bots.length; i++) {
			if (bots[i].problems) {
				result.push(bots[i]);
			}
		}
		return result;
	};
})
.controller('MonitoringController',
		[ '$scope', '$http', '$interval', '$location', function($scope, $http, $interval, $location) {
			$scope.botName = $location.search().name;
			$scope.faction = "Alliance";
			$scope.viewMode = "Map";
			$scope.mapId = 0;
			$scope.sortBy = "name";
			$scope.sortDesc = false;

			$scope.bots = [];
			$scope.botsLoading = false
			$scope.liveUpdate = null;
			$scope.iterCount = STALE_ITER_COUNT;
			$scope.coldStart = true;

			$scope.stopLiveUpdate = function() {
				if ($scope.liveUpdate) {
					$interval.cancel($scope.liveUpdate);
				}
				$scope.liveUpdate = null;
			};

			$scope.changeSortOrder = function(sortBy) {
			    $scope.sortDesc = ($scope.sortBy === sortBy) ? !$scope.sortDesc : false;
			    $scope.sortBy = sortBy;
		    };

			function convertAction(str) {
				var p1 = str.indexOf(":");
				var p2 = str.lastIndexOf(" - ");
				var action = { type: "info", text: str };
				if (p1 != -1) {
					action.type = str.substring(0, p1);
				}
				if (p2 != -1) {
					action.result = str.substring(p2 + 3);
				}
				if (p1 != -1 && p2 == -1) {
					action.text = str.substring(p1 + 1);
				}
				if (p1 != -1 && p2 != -1) {
					action.text = str.substring(p1 + 1, p2);
				}
				return action;
			}

			function groupActions(actions) {
				var result = [];
				var type;
				for (var i = 0; i < actions.length; i++) {
					var action = actions[i];
					if (!action.text) continue;
					if (action.type == "info" || action.type == "T") {
						result.push({type: action.type, actions: [action]});
					} else if (action.type != type) {
						type = action.type;
						result.push({type: type, actions: [action]});
					} else {
						result[result.length - 1].actions.push(action);
					}
				}
				return result;
			}

			function buildMinimap(bot) {
				var pos = bot.liveData.position.split(" ");
				var botX = parseFloat(pos[0]);
				var botY = parseFloat(pos[1]);

				var minimap = bot.minimap;
				if (!minimap) {
					minimap = {};
				}

				var cx = botX, cy = botY;
				if (!minimap.translate || Math.sqrt((cx + minimap.translate.x)*(cx + minimap.translate.x) + (cy + minimap.translate.y)*(cy + minimap.translate.y)) > 15) {
					minimap.translate = {x: -cx, y : -cy};
				}

				minimap.bot = { x: botX, y: botY };

				var tpos = bot.liveData.tpos.split(" ");
				if (tpos) {
					minimap.target = { x: parseFloat(tpos[0]), y: parseFloat(tpos[1]) };
				}

				var movement = bot.liveData.movement.split(" ");
				if (movement) {
					minimap.movement = { x: parseFloat(movement[0]), y: parseFloat(movement[1]) };
				}

				return minimap;
			}

			function buildMap(data, mapId) {
				var left = 0, right = 0, top = 0, bottom = 0;
				switch (mapId)
				{
				case 0:
					left = -6199.9;
					top = -10000;
					right = 16000;
					bottom = 7466.6;
					break;
				case 1:
					left = -11733.2;
					right = 11066.6;
					top = -5733.3;
					bottom = 12799.9;
					break;
				}
				var bots = [];
				var mapWidth = right - left;
				var mapHeight = bottom - top;
				$($scope.bots).each(function(idx, bot) {
					var liveData = data[bot.guid];
					var pos = liveData.position.split(" ");
					var botMap = parseFloat(pos[3]);
					if (botMap != mapId) return;

					var botX = parseFloat(pos[0]);
					var botY = parseFloat(pos[1]);
					bots.push({
						y: botX,
						x: botY,
						map: botMap,
						liveData: liveData,
						name: bot.name,
						location: extractLocation(liveData.position)
					});
				});

				var canvasWidth = 450.0, canvasHeight = 300.0;
				var scaleX = canvasWidth / mapWidth,
					scaleY = canvasHeight / mapHeight,
					scale = Math.min(scaleX, scaleY);

				//canvasWidth = Math.ceil(mapWidth * scale);
				//canvasHeight = Math.ceil(mapHeight * scale);

				$(bots).each(function() {
					this.r = 5 / scale;
					this.title = this.name + " (" + this.location + ") x=" + this.x + ", y=" + this.y + ", map="+this.map;
				});

				return {
					scale: {y: scaleX, x: scaleY},
					id: mapId,
					size: {
						y: canvasWidth,
						x: canvasHeight
					},
					rotate: {
						a: 180
					},
					translate: {
						y: -left,
						x: -top
					},
					bots: bots
				};
			}

			function splitValues(str) {
				var result = [];
				var map = {};
				var values = str.split("|");
				angular.forEach(values, function(value) {
					if (value) {
						var ss = value.substring(1, value.length - 1).split("=");
						if (!map[ss[0]]) {
							map[ss[0]] = true;
							result.push({ name: ss[0], value: ss[1] });
						}
					}
				});
				return result;
			}

			function monitorProblems(bot) {
          	  	var ctx = this[bot.guid];
          	  	if (!ctx) ctx = this[bot.guid] = { lastActionCount: 0 };

				var strategies = [
					  function(bot) {
						  if (ctx.lastAction == bot.liveData.lastAction.text) ctx.lastActionCount++;
						  else ctx.lastActionCount = 0;
						  ctx.lastAction = bot.liveData.lastAction.text;

						  return ctx.lastActionCount > STALE_ITER_COUNT ? "StaleAction (" + ctx.lastAction + ")" : "";
					  },
					  function(bot) {
						  if (!bot.liveData.target || bot.liveData.state == "dead") return "";

						  if (ctx.target == bot.liveData.target) ctx.sameTargetCount++;
						  else ctx.sameTargetCount = 0;
						  ctx.target = bot.liveData.target;

						  return ctx.sameTargetCount > STALE_ITER_COUNT ? "StaleTarget (" + ctx.target + ")" : "";
					  }
                ];
				var result = [];
				for (var i = 0; i < strategies.length; i++) {
					var problem = strategies[i](bot);
					if (problem) result.push(problem);
				}
				return result.toString();
			}

			function extractLocation(position) {
				var start = position.indexOf("|");
				var end = position.indexOf("|", start + 1);
				return position.substr(start + 1, end - 1);
			}

			$scope.openBot = function(bot) {
				window.open('bot.html?name=' + bot.name, '_blank');
			}

			$scope.startLiveUpdate = function() {
				$scope.liveUpdate = $interval(function() {
					$http.post("bot/live-data.json",
							$scope.bots.map(function(item) { return item.guid; })
					).success(function(data) {
						$($scope.bots).each(function(idx, bot) {
							bot.liveData = data[bot.guid];

							bot.liveData.actions = [];
							angular.forEach(bot.liveData.action.split("|"), function(action) {
								bot.liveData.actions.push(convertAction(action));
							});
							bot.liveData.lastAction = bot.liveData.actions[bot.liveData.actions.length - 1];
							if ($scope.bots.length == 1) {
								bot.liveData.actionGroups = groupActions(bot.liveData.actions);
								bot.liveData.valueList = splitValues(bot.liveData.values);
								bot.minimap = buildMinimap(bot);
							}

							if (!bot.actionHistory) bot.actionHistory = [];
							angular.forEach(bot.liveData.actionGroups, function(group) {
								bot.actionHistory.push(group);
							});
							if (bot.actionHistory.length > MAX_HISTORY_SIZE) bot.actionHistory.splice(0, bot.actionHistory.length - MAX_HISTORY_SIZE);

							bot.problems = monitorProblems(bot);
							if (bot.liveData.position) {
								bot.liveData.location = extractLocation(bot.liveData.position);
							}
						});
						$scope.maps = [buildMap(data, 0), buildMap(data, 1)];
						if ($scope.iterCount-- <= 0) $scope.coldStart = false;
					});
				}, UPDATE_INTERVAL);
			};

			$scope.search = function() {
				$scope.bots = [];
				$scope.botsLoading = true;
				$http.post("bots.json", {
					'name' : $scope.botName,
					'faction' : $scope.faction,
				}).success(function(data) {
					$scope.bots = data;
					$scope.botsLoading = false;
					$scope.startLiveUpdate();
				});
			};



			$scope.search();
		} ]);