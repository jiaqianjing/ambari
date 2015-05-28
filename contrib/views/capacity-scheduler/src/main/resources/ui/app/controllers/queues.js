/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var App = require('app');

var cmp = Ember.computed;

App.QueuesController = Ember.ArrayController.extend({
  sortProperties: ['name'],
  sortAscending: true,
  actions:{
    loadTagged:function (tag) {
      this.transitionToRoute('queue','root').then(function() {
         this.store.fetchTagged(App.Queue,tag);
       }.bind(this));
    },
    askPath:function () {
      this.set('isWaitingPath',true);
    },
    addQ:function (parentPath,name) {
      if (!parentPath || this.get('hasNewQueue') || !this.store.hasRecordForId('queue',parentPath.toLowerCase())) {
        return;
      }
      name = name || '';
      var newQueue,
          existed = this.get('store.deletedQueues').findBy('path',parentPath+'.'+name);

      if (existed) {
        newQueue = this.store.createFromDeleted(existed);
      } else {
        newQueue = this.store.createRecord('queue', {
          name:name,
          parentPath: parentPath,
          depth: parentPath.split('.').length,
          isNewQueue:true
        });
        this.set('newQueue',newQueue);
      }

      if (name) {
        this.get('store').saveAndUpdateQueue(newQueue,existed)
          .then(Em.run.bind(this,'transitionToRoute','queue'))
          .then(Em.run.bind(this,'set','newQueue',null));
      } else {
        this.transitionToRoute('queue',newQueue);
      }
    },
    downloadConfig: function (format) {
      var config =  this.get('store').buildConfig(format);
      return this.fileSaver.save(config, "application/json", 'scheduler_config_' + moment() + '.' + format);
    },
    createQ:function (record,updates) {
      this.get('store').saveAndUpdateQueue(record, updates);
    },
    delQ:function (record) {
      if (record.isCurrent) {
        this.transitionToRoute('queue',record.get('parentPath').toLowerCase())
          .then(Em.run.schedule('afterRender', function () {
            record.get('store').recurceRemoveQueue(record);
          }));
      } else {
        record.destroyRecord();
      }
    },
    saveConfig:function (mark) {
      if (mark == 'restart') {
        this.get('store').markForRestart();
      } else if (mark == 'refresh') {
        this.get('store').markForRefresh();
      }
      var collectedLabels = this.get('model').reduce(function (prev,q) {
        return prev.pushObjects(q.get('labels.content'));
      },[]);

      var scheduler = this.get('scheduler').save(),
          model = this.get('model').save(),
          labels = DS.ManyArray.create({content:collectedLabels}).save();

      Em.RSVP.Promise.all([labels,model,scheduler]).then(
        Em.run.bind(this,'saveSuccess'),
        Em.run.bind(this,'saveError')
      );

    },
    clearAlert:function () {
      this.set('alertMessage',null);
    }
  },

  /**
   * User admin status.
   * @type {Boolean}
   */
  isOperator:false,

  /**
   * Inverted isOperator value.
   * @type {Boolean}
   */
  isNotOperator:cmp.not('isOperator'),

  /**
   * Flag to show input for adding queue.
   * @type {Boolean}
   */
  isWaitingPath:false,

  /**
   * Property for error message which may appear when saving queue.
   * @type {Object}
   */
  alertMessage:null,

  /**
   * Temporary filed for new queue
   * @type {App.Queue}
   */
  newQueue:null,

  /**
   * True if newQueue is not empty.
   * @type {Boolean}
   */
  hasNewQueue: cmp.bool('newQueue'),

  /**
   * Current configuration version tag.
   * @type {[type]}
   */
  current_tag: cmp.alias('store.current_tag'),

  /**
   * Scheduler record
   * @type {App.Scheduler}
   */
  scheduler:null,

  /**
   * Collection of modified fields in Scheduler.
   * @type {Object} - { [fileldName] : {Boolean} }
   */
  schedulerDirtyFilelds:{},


  configNote: cmp.alias('store.configNote'),

  tags:function () {
    return this.store.find('tag');
  }.property('store.current_tag'),

  sortedTags: cmp.sort('tags', function(a, b){
    return (+a.id > +b.id)?(+a.id < +b.id)?0:-1:1;
  }),

  saveSuccess:function () {
    this.set('store.deletedQueues',[]);
  },

  saveError:function (error) {
    var response = JSON.parse(error.responseText);
    this.set('alertMessage',response);
  },

  propertyBecomeDirty:function (controller,property) {
    var schedProp = property.split('.').objectAt(1);
    this.set('schedulerDirtyFilelds.' + schedProp, this.get('scheduler').changedAttributes().hasOwnProperty(schedProp));
  },

  dirtyObserver:function () {
    this.get('scheduler.constructor.transformedAttributes.keys.list').forEach(function(item) {
      this.addObserver('scheduler.' + item,this,'propertyBecomeDirty');
    }.bind(this));
  }.observes('scheduler'),


  trackNewQueue:function () {
    var newQueue = this.get('newQueue'), props;
    if (Em.isEmpty(newQueue)) {
      return;
    }

    props = newQueue.getProperties('name','parentPath');

    newQueue.setProperties({
      name: props.name.replace(/\s/g, ''),
      path: props.parentPath+'.'+props.name,
      id: (props.parentPath+'.'+props.name).toLowerCase()
    });

  }.observes('newQueue.name'),

  /**
   * Marks each queue in leaf with 'overCapacity' if sum if their capacity values is greater then 100.
   * @method capacityControl
   */
  capacityControl: function() {
    var pathes = this.get('content').getEach('parentPath').uniq();
    pathes.forEach(function (path) {
      var leaf = this.get('content').filterBy('parentPath',path),
      total = leaf.reduce(function (prev, queue) {
          return +queue.get('capacity') + prev;
        },0);

      leaf.setEach('overCapacity',total>100);
    }.bind(this));
  }.observes('content.length','content.@each.capacity'),



  // TRACKING OF RESTART REQUIREMENT

  /**
   * check if RM needs restart
   * @type {bool}
   */
  needRestart: Em.computed.and('hasDeletedQueues','isOperator'),

  /**
   * True if some queue of desired configs was removed.
   * @type {Boolean}
   */
  hasDeletedQueues: Em.computed.alias('store.hasDeletedQueues'),



  // TRACKING OF REFRESH REQUIREMENT

  /**
   * check if RM needs refresh
   * @type {bool}
   */
  needRefresh: cmp.and('needRefreshProps','noNeedRestart','isOperator'),

  /**
   * Inverted needRestart value.
   * @type {Boolean}
   */
  noNeedRestart: cmp.not('needRestart'),

  /**
   * Check properties for refresh requirement
   * @type {Boolean}
   */
  needRefreshProps: cmp.any('hasChanges', 'hasNewQueues','dirtyScheduler'),

  /**
   * List of modified queues.
   * @type {Array}
   */
  dirtyQueues:function () {
    return this.get('content').filter(function (q) {
      return q.get('isAnyDirty');
    });
  }.property('content.@each.isAnyDirty'),

  /**
   * True if dirtyQueues is not empty.
   * @type {Boolean}
   */
  hasChanges: cmp.notEmpty('dirtyQueues.[]'),

  /**
   * List of new queues.
   * @type {Array}
   */
  newQueues: cmp.filterBy('content', 'isNewQueue', true),

  /**
   * True if newQueues is not empty.
   * @type {Boolean}
   */
  hasNewQueues: cmp.notEmpty('newQueues.[]'),

  /**
   * True if scheduler is modified.
   * @type {[type]}
   */
  dirtyScheduler: cmp.bool('scheduler.isDirty'),


   // TRACKING OF PRESERVATION POSSIBILITY

  /**
   * check there is some changes for save
   * @type {bool}
   */
  needSave: cmp.any('needRestart', 'needRefresh'),

  /**
   * check if can save configs
   * @type {bool}
   */
  canNotSave: cmp.any('hasOverCapacity', 'hasUncompetedAddings','hasNotValid'),

  /**
   * List of not valid queues.
   * @type {Array}
   */
  notValid:cmp.filterBy('content','isValid',false),

  /**
   * True if notValid is not empty.
   * @type {Boolean}
   */
  hasNotValid:cmp.notEmpty('notValid.[]'),

  /**
   * List of queues with excess of capacity
   * @type {Array}
   */
  overCapacityQ:function () {
    return this.get('content').filter(function (q) {
      return q.get('overCapacity');
    });
  }.property('content.@each.overCapacity'),

  /**
   * True if overCapacityQ is not empty.
   * @type {Boolean}
   */
  hasOverCapacity:cmp.notEmpty('overCapacityQ.[]'),

  /**
   * List of queues with incompete adding process
   * @type {[type]}
   */
  uncompetedAddings:cmp.filterBy('content', 'isNew', true),

  /**
   * True if uncompetedAddings is not empty.
   * @type {Boolean}
   */
  hasUncompetedAddings:cmp.notEmpty('uncompetedAddings.[]')
});
