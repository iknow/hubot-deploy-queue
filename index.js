var queue = require('./lib/queue')
  , _ = require('lodash')
  , timeout = null
  , TIMEOUT_DURATION = 30 * 60 * 1000; // 30 min

module.exports = function(robot) {
  robot.brain.on('loaded', function() {
    queue.init(robot);
  });

  robot.respond(/deploy help/i, help);
  robot.respond(/deploy (add)(.*)?/i, queueUser);
  robot.respond(/deploy (done|complete)/i, dequeueUser);
  robot.respond(/deploy (current|who\'s deploying)/i, whosDeploying);
  robot.respond(/deploy (next|who\'s next)/i, whosNext);
  robot.respond(/deploy (remove|kick) (.*)/i, removeUser);
  robot.respond(/deploy (list)/i, listQueue);
  robot.respond(/deploy (dump|debug)/i, queueDump);

  robot.respond(/deploy ping/i, function(res) {
    res.send('deploy pong');
    res.reply('deploy reply pong');
  });

  /**
   * Help stuff
   * @param res
   */
  function help(res) {
    res.send(
      '`deploy add _metadata_`: Add yourself to the deploy queue. Hubot give you a heads up when it\'s your turn. Anything after `add` will be included in messages about what you\'re deploying. Something like `hubot deploy add my_api`.\n' +
      '`deploy done`: Say this when you\'re done and then Hubot will tell the next person. Or you could say `deploy complete`.\n' +
      '`deploy remove _user_`: Removes a user completely from the queue. Use `remove me` to remove yourself. Also works with `deploy kick _user_`.\n' +
      '`deploy next`: Sneak peek at the next person in line. Also works with `deploy who\'s next` and `deploy who\'s on first`.\n' +
      '`deploy list`: Lists the queue.\n' +
      '`deploy debug`: Kinda like `deploy list`.\n'
    );
  }

  function pingInactive(user) {
    if (queue.isCurrent(user)) {
      robot.messageRoom(user.id, 'Are you still deploying?');
    }
  }

  function cycleTimeout(user) {
    clearTimeout(timeout);
    timeout = setTimeout(function() {
      pingInactive(user);
    }, TIMEOUT_DURATION);
  }

  function getUserName(user) {
    const fullUser = robot.brain.userForId(user.id);
    if (fullUser.slack) {
      return fullUser.slack.profile.display_name;
    } else {
      return fullUser.name;
    }
  }

  /**
   * Add a user to the queue
   * @param res
   */
  function queueUser(res) {
    const user = { id: res.message.user.id };

    var  metadata = (res.match[2] || '').trim()
      , length = 0
      , isCurrent = false
      , grouped = [];

    queue.push({ ...user, metadata });

    length = queue.length();
    isCurrent = queue.isCurrent(user);
    grouped = firstGroup();

    if (length === 1) {
      res.reply('Go for it!');
      cycleTimeout(user);
    } else if (length === 2 && !isCurrent) {
      res.reply('Alrighty, you\'re up after the current deployer.');
    } else if (isCurrent && length === grouped.length) {
      cycleTimeout(user);
      res.reply('Ok! You are now deploying ' + grouped.length + ' things in a row.');
    } else {
      res.reply('There\'s ' + (length - 1) + ' things to deploy in the queue ahead of you. I\'ll let you know when you\'re up.');
    }
  }

  /**
   * Removes a user from the queue if they exist and notifies the next user
   * @param res
   */
  function dequeueUser(res) {
    const user = { id: res.message.user.id };

    if (!queue.contains(user)) {
      res.reply('Ummm, this is a little embarrassing, but you aren\'t in the queue :grimacing:');
      return;
    }

    if (!queue.isCurrent(user)) {
      res.reply('Nice try, but it\'s not your turn yet');
      return;
    }

    queue.advance();
    var grouped = firstGroup();

    if (queue.isCurrent(user)) {
      cycleTimeout(user);
      res.reply('Nice! Only ' + grouped.length + ' more to go! ' + getRandomReaction());
    } else {
      clearTimeout(timeout);
      res.reply('Nice job! :tada:');
    }

    if (!queue.isEmpty() && !queue.isCurrent(user)) {
      // Send DM to next in line if the queue isn't empty and it's not the person who just finished deploying.
      notifyUser(queue.current());
    }
  }

  /**
   * Who's deploying now?
   * @param res
   */
  function whosDeploying(res) {
    const user = { id: res.message.user.id };

    if (queue.isEmpty()) {
      res.send('Nobody!');
    } else if (queue.isCurrent(user)) {
      res.reply('It\'s you. _You\'re_ deploying. Right now.');
    } else {
      var current = queue.current()
        , message = getUserName(current) + ' is deploying'
        , grouped = firstGroup();

      if (grouped.length === 1) {
        message += current.metadata ? ' ' + current.metadata : '.';
      } else {
        message += ' ' + grouped.length + ' items.';
      }

      res.send(message);
    }
  }

  /**
   * Who's up next?
   * @param res
   */
  function whosNext(res) {
    const user = { id: res.message.user.id };
    const next = queue.next();

    if (!next) {
      res.send('Nobody!');
    } else if (queue.isNext(user)) {
      res.reply('You\'re up next!');
    } else {
      res.send(getUserName(next) + ' is next.');
    }
  }

  /**
   * Removes all references to a user from the queue
   * @param res
   */
  function removeUser(res) {
    const name = res.match[2];
    if (name === 'me') {
      removeMe(res);
      return;
    }

    const matchByUserName = (item) => getUserName(item) === name;

    const isCurrent = queue.isCurrent(matchByUserName);
    const notifyNextUser = isCurrent && queue.length() > 1;

    const removed = queue.remove(matchByUserName);
    if (removed === 0) {
      res.send(name + ' isn\'t in the queue :)');
      return;
    }
    clearTimeout(timeout);
    res.send(name + ' has been removed from the queue. I hope that\'s what you meant to do...');

    if (notifyNextUser) {
      notifyUser(queue.current());
    }
  }

  /**
   * Removes the current user from the queue IF the user is not at the head.
   * @param res
   */
  function removeMe(res) {
    const user = { id: res.message.user.id };
    const wasCurrent = queue.isCurrent(user);

    if (!queue.contains(user)) {
      res.reply('No sweat! You weren\'t even in the queue :)');
    } else {
      queue.remove((item) => item.id === user.id);
      clearTimeout(timeout);
      res.reply('Alright, I took you out of the queue. Come back soon!');
      if (!queue.isEmpty() && wasCurrent) {
        // Send DM to next in line if the queue isn't empty and it's not the person who just finished deploying.
        notifyUser(queue.current());
      }
    }
  }

  /**
   * Prints a list of users in the queue
   * @param res
   */
  function listQueue(res) {
    if (queue.isEmpty()) {
      res.send('Nobody!');
    } else {
      res.send('Here\'s who\'s in the queue: ' + queue.get().map(getUserName).join(', ') + '.');
    }
  }

  /**
   * Dumps the queue to the channel for debugging
   * @param res
   */
  function queueDump(res) {
    res.send(JSON.stringify(queue.get(), null, 2));
  }

  /**
   * Get a list of all the items at the beginning of the queue for a given user.
   */
  function firstGroup() {
    var queueValue = queue.get();
    if (queueValue[0] === undefined) {
      return [];
    }

    var last = queueValue[0]
      , group = [queueValue[0]];
    for (var index = 0; index < queueValue.length; index++) {
      var next = queueValue[index + 1];
      if (next && next.id === last.id) {
        group.push(next);
        last = next;
      } else {
        break;
      }
    }

    return group;
  }

  /**
   * Notify a user via DM that it's their turn
   * @param user
   */
  function notifyUser(user) {
    robot.messageRoom(user.id, 'Hey, it\'s your turn to deploy!');
    cycleTimeout(user);
  }

  function getRandomReaction() {
    var reactions = [':smart:', ':rocket:', ':hyperclap:', ':confetti_ball:'];
    return reactions[Math.floor(Math.random() * reactions.length)];
  }
};
