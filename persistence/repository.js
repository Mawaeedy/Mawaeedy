const { validateProfilePatch, validateMeetingType, validateSchedule, normalizeIntervals, normalizeOverride } = require('../core/validation');
const { sanitizePublicAvailability } = require('../core/availability');

function ownerFilter(ownerId) {
  if (!ownerId) throw new Error('Authenticated owner id is required.');
  return `owner_id=eq.${encodeURIComponent(ownerId)}`;
}

function publicProfile(row) {
  if (!row) return null;
  return {
    name: row.name || '',
    photo: row.photo || '',
    bio: row.bio || '',
    title: row.job_title || row.title || '',
    job_title: row.job_title || row.title || '',
    location: row.location || '',
    timezone: row.timezone || 'Asia/Riyadh',
    slug: row.slug || ''
  };
}

function appProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || '',
    title: row.job_title || row.title || '',
    location: row.location || '',
    bio: row.bio || '',
    photo: row.photo || '',
    timezone: row.timezone || 'Asia/Riyadh',
    slug: row.slug || '',
    locale: row.locale || 'ar'
  };
}

function mapMeetingType(row) {
  return {
    id: row.id,
    supabaseId: row.id,
    name: row.name_ar || '',
    en: row.name_en || '',
    duration: Number(row.duration_minutes),
    color: row.color || '#2166f3',
    mode: row.mode || 'custom',
    slug: row.slug || null,
    description: row.description || '',
    descriptionAr: row.description_ar || '',
    bufferBeforeMinutes: Number(row.buffer_before_minutes || 0),
    bufferAfterMinutes: Number(row.buffer_after_minutes || 0),
    minimumNoticeMinutes: row.minimum_notice_minutes == null ? null : Number(row.minimum_notice_minutes),
    bookingHorizonDays: row.booking_horizon_days == null ? null : Number(row.booking_horizon_days),
    active: row.active !== false
  };
}

function mapSchedule(row) {
  return { id: row.id, ownerId: row.owner_id, name: row.name, timezone: row.timezone, isDefault: Boolean(row.is_default), createdAt: row.created_at || null, updatedAt: row.updated_at || null };
}

function mapInterval(row) {
  return { id: row.id, scheduleId: row.schedule_id, weekday: Number(row.weekday), startLocal: String(row.start_local).slice(0, 5), endLocal: String(row.end_local).slice(0, 5) };
}

function mapOverride(row) {
  return { id: row.id, ownerId: row.owner_id, scheduleId: row.schedule_id || null, overrideDate: row.override_date, isAvailable: Boolean(row.is_available), startLocal: row.start_local ? String(row.start_local).slice(0, 5) : null, endLocal: row.end_local ? String(row.end_local).slice(0, 5) : null, reason: row.reason || null };
}

function createSqliteAdapter(db) {
  function state() { return db.read(); }
  function structured(data) {
    data.availabilityStructured ||= { schedules: [], intervals: [], overrides: [] };
    return data.availabilityStructured;
  }
  function ownerMatches(ownerId, data) {
    return String(data.users?.[0]?.id || 'owner') === String(ownerId);
  }
  return {
    async getProfileByOwner(ownerId) {
      const data = state();
      if (!ownerMatches(ownerId, data)) return null;
      return appProfile({ id: ownerId, ...data.profile });
    },
    async getPublicProfileBySlug(slug) {
      const data = state();
      if (String(data.profile?.slug || 'ahmed') !== String(slug)) return null;
      const ownerId = data.users?.[0]?.id || 'owner';
      return { profile: publicProfile({ ...data.profile, slug }), meetingTypes: (data.meetingTypes || []).filter(item => item.active !== false), availability: await this.getPublicAvailability(ownerId) };
    },
    async updateProfile(ownerId, changes) {
      const data = state();
      if (!ownerMatches(ownerId, data)) return null;
      data.profile = { ...data.profile, ...changes };
      db.write(data);
      return appProfile({ id: ownerId, ...data.profile });
    },
    async listMeetingTypes(ownerId) {
      const data = state();
      if (!ownerMatches(ownerId, data)) return [];
      return (data.meetingTypes || []).filter(item => item.active !== false);
    },
    async getMeetingType(ownerId, meetingTypeId) {
      return (await this.listMeetingTypes(ownerId)).find(item => String(item.id) === String(meetingTypeId)) || null;
    },
    async createMeetingType(ownerId, input) {
      const data = state();
      if (!ownerMatches(ownerId, data)) throw new Error('Owner profile not found.');
      const values = validateMeetingType(input);
      const item = { id: `local-${Date.now()}`, name: String(input.nameAr ?? input.name ?? '').trim(), en: String(input.nameEn ?? input.en ?? '').trim(), duration: values.durationMinutes, color: input.color || '#2166f3', mode: input.locationType || input.mode || 'custom', active: true };
      data.meetingTypes = [...(data.meetingTypes || []), item];
      db.write(data);
      return item;
    },
    async updateMeetingType(ownerId, meetingTypeId, input) {
      const data = state();
      if (!ownerMatches(ownerId, data)) return null;
      const index = (data.meetingTypes || []).findIndex(item => String(item.id) === String(meetingTypeId));
      if (index < 0) return null;
      const current = data.meetingTypes[index];
      const values = validateMeetingType({ ...current, ...input, durationMinutes: input.durationMinutes ?? input.duration ?? current.duration });
      data.meetingTypes[index] = { ...current, ...input, duration: values.durationMinutes, active: input.active !== false };
      db.write(data);
      return data.meetingTypes[index];
    },
    async deactivateMeetingType(ownerId, meetingTypeId) {
      return this.updateMeetingType(ownerId, meetingTypeId, { active: false });
    },
    async listAvailabilitySchedules(ownerId) {
      const data = state();
      if (!ownerMatches(ownerId, data)) return [];
      return structured(data).schedules.filter(item => item.owner_id === ownerId).map(mapSchedule);
    },
    async getAvailabilitySchedule(ownerId, scheduleId) {
      return (await this.listAvailabilitySchedules(ownerId)).find(item => String(item.id) === String(scheduleId)) || null;
    },
    async getAvailability(ownerId) {
      const data = state();
      if (!ownerMatches(ownerId, data)) return { schedule: null, intervals: [], overrides: [] };
      const store = structured(data);
      const schedules = store.schedules.filter(item => item.owner_id === ownerId);
      const schedule = schedules.find(item => item.is_default === true) || null;
      if (!schedule) return { schedule: null, intervals: [], overrides: store.overrides.filter(item => item.owner_id === ownerId).map(mapOverride) };
      return {
        schedule: mapSchedule(schedule),
        intervals: store.intervals.filter(item => item.schedule_id === schedule.id).map(mapInterval),
        overrides: store.overrides.filter(item => item.owner_id === ownerId && (!item.schedule_id || item.schedule_id === schedule.id)).map(mapOverride)
      };
    },
    async createAvailabilitySchedule(ownerId, input) {
      const data = state();
      if (!ownerMatches(ownerId, data)) throw new Error('Owner profile not found.');
      const values = validateSchedule(input);
      const store = structured(data);
      if (values.isDefault) store.schedules.forEach(item => { if (item.owner_id === ownerId) item.is_default = false; });
      const row = { id: `local-schedule-${Date.now()}`, owner_id: ownerId, name: values.name, timezone: values.timezone, is_default: values.isDefault, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      store.schedules.push(row);
      db.write(data);
      return mapSchedule(row);
    },
    async updateAvailabilitySchedule(ownerId, scheduleId, input) {
      const data = state();
      if (!ownerMatches(ownerId, data)) return null;
      const store = structured(data);
      const row = store.schedules.find(item => item.owner_id === ownerId && String(item.id) === String(scheduleId));
      if (!row) return null;
      const values = validateSchedule({ name: input.name ?? row.name, timezone: input.timezone ?? row.timezone, isDefault: input.isDefault ?? row.is_default });
      if (values.isDefault) store.schedules.forEach(item => { if (item.owner_id === ownerId) item.is_default = false; });
      Object.assign(row, { name: values.name, timezone: values.timezone, is_default: values.isDefault, updated_at: new Date().toISOString() });
      db.write(data);
      return mapSchedule(row);
    },
    async deleteAvailabilitySchedule(ownerId, scheduleId) {
      const data = state();
      if (!ownerMatches(ownerId, data)) return null;
      const store = structured(data);
      const index = store.schedules.findIndex(item => item.owner_id === ownerId && String(item.id) === String(scheduleId));
      if (index < 0) return null;
      store.schedules.splice(index, 1);
      store.intervals = store.intervals.filter(item => String(item.schedule_id) !== String(scheduleId));
      store.overrides = store.overrides.filter(item => String(item.schedule_id) !== String(scheduleId));
      db.write(data);
      return { id: scheduleId, deleted: true };
    },
    async replaceScheduleIntervals(ownerId, scheduleId, intervals) {
      const data = state();
      if (!ownerMatches(ownerId, data)) throw new Error('Owner profile not found.');
      const schedule = structured(data).schedules.find(item => item.owner_id === ownerId && String(item.id) === String(scheduleId));
      if (!schedule) return null;
      const normalized = normalizeIntervals(intervals);
      const store = structured(data);
      store.intervals = store.intervals.filter(item => String(item.schedule_id) !== String(scheduleId));
      store.intervals.push(...normalized.map((item, index) => ({ id: `local-interval-${Date.now()}-${index}`, schedule_id: scheduleId, weekday: item.weekday, start_local: item.startLocal, end_local: item.endLocal })));
      db.write(data);
      return this.getAvailability(ownerId);
    },
    async listAvailabilityOverrides(ownerId) {
      const data = state();
      if (!ownerMatches(ownerId, data)) return [];
      return structured(data).overrides.filter(item => item.owner_id === ownerId).map(mapOverride);
    },
    async createAvailabilityOverride(ownerId, input) {
      const data = state();
      if (!ownerMatches(ownerId, data)) throw new Error('Owner profile not found.');
      const values = normalizeOverride(input);
      const store = structured(data);
      const scheduleId = input.scheduleId ?? input.schedule_id ?? null;
      if (scheduleId && !store.schedules.some(item => item.owner_id === ownerId && String(item.id) === String(scheduleId))) return null;
      if (store.overrides.some(item => item.owner_id === ownerId && item.override_date === values.overrideDate)) throw new Error('An override already exists for this date.');
      const row = { id: `local-override-${Date.now()}`, owner_id: ownerId, schedule_id: scheduleId, override_date: values.overrideDate, is_available: values.isAvailable, start_local: values.startLocal, end_local: values.endLocal, reason: values.reason, created_at: new Date().toISOString() };
      store.overrides.push(row);
      db.write(data);
      return mapOverride(row);
    },
    async updateAvailabilityOverride(ownerId, overrideId, input) {
      const data = state();
      if (!ownerMatches(ownerId, data)) return null;
      const store = structured(data);
      const row = store.overrides.find(item => item.owner_id === ownerId && String(item.id) === String(overrideId));
      if (!row) return null;
      const values = normalizeOverride({ overrideDate: input.overrideDate ?? row.override_date, isAvailable: input.isAvailable ?? row.is_available, startLocal: input.startLocal ?? row.start_local, endLocal: input.endLocal ?? row.end_local, reason: input.reason ?? row.reason });
      if (store.overrides.some(item => item.owner_id === ownerId && item.id !== row.id && item.override_date === values.overrideDate)) throw new Error('An override already exists for this date.');
      Object.assign(row, { override_date: values.overrideDate, is_available: values.isAvailable, start_local: values.startLocal, end_local: values.endLocal, reason: values.reason });
      db.write(data);
      return mapOverride(row);
    },
    async deleteAvailabilityOverride(ownerId, overrideId) {
      const data = state();
      if (!ownerMatches(ownerId, data)) return null;
      const store = structured(data);
      const index = store.overrides.findIndex(item => item.owner_id === ownerId && String(item.id) === String(overrideId));
      if (index < 0) return null;
      store.overrides.splice(index, 1);
      db.write(data);
      return { id: overrideId, deleted: true };
    },
    async getPublicAvailability(ownerId) {
      return sanitizePublicAvailability(await this.getAvailability(ownerId));
    }
  };
}

function createSupabaseAdapter(client) {
  async function getProfileByOwner(ownerId) {
    const rows = await client.list('profiles', `?id=eq.${encodeURIComponent(ownerId)}&select=*`);
    return appProfile(rows[0]);
  }
  async function listMeetingTypes(ownerId, activeOnly = false) {
    const active = activeOnly ? '&active=eq.true' : '';
    const rows = await client.list('meeting_types', `?${ownerFilter(ownerId)}&select=*&order=created_at.asc${active}`);
    return rows.map(mapMeetingType);
  }
  return {
    getProfileByOwner,
    async getPublicProfileBySlug(slug) {
      const rows = await client.list('profiles', `?slug=eq.${encodeURIComponent(slug)}&select=name,photo,bio,job_title,timezone,slug,id&limit=1`);
      const row = rows[0];
      if (!row) return null;
      return { profile: publicProfile(row), meetingTypes: await listMeetingTypes(row.id, true), availability: await this.getPublicAvailability(row.id) };
    },
    async updateProfile(ownerId, changes) {
      const normalized = validateProfilePatch(changes);
      const values = {};
      if (normalized.displayName !== undefined) values.name = normalized.displayName;
      if (normalized.bookingSlug !== undefined) values.slug = normalized.bookingSlug;
      if (normalized.locale !== undefined) values.locale = normalized.locale;
      if (normalized.timezone !== undefined) values.timezone = normalized.timezone;
      if (changes.photo !== undefined) values.photo = changes.photo;
      if (changes.bio !== undefined) values.bio = changes.bio;
      if (changes.job_title !== undefined || changes.title !== undefined) values.job_title = changes.job_title ?? changes.title;
      const rows = await client.update('profiles', values, `?id=eq.${encodeURIComponent(ownerId)}`);
      return appProfile(rows[0]);
    },
    listMeetingTypes: ownerId => listMeetingTypes(ownerId, false),
    async getMeetingType(ownerId, meetingTypeId) {
      const rows = await client.list('meeting_types', `?${ownerFilter(ownerId)}&id=eq.${encodeURIComponent(meetingTypeId)}&select=*&limit=1`);
      return rows[0] ? mapMeetingType(rows[0]) : null;
    },
    async createMeetingType(ownerId, input) {
      const values = validateMeetingType(input);
      const rows = await client.insert('meeting_types', {
        owner_id: ownerId,
        name_ar: String(input.nameAr ?? input.name ?? '').trim(),
        name_en: String(input.nameEn ?? input.en ?? '').trim(),
        duration_minutes: values.durationMinutes,
        buffer_before_minutes: values.bufferBeforeMinutes,
        buffer_after_minutes: values.bufferAfterMinutes,
        minimum_notice_minutes: values.minimumNoticeMinutes,
        booking_horizon_days: values.bookingHorizonDays,
        mode: input.locationType || input.mode || 'custom',
        color: input.color || '#2166f3',
        active: true
      });
      return rows[0] ? mapMeetingType(rows[0]) : null;
    },
    async updateMeetingType(ownerId, meetingTypeId, input) {
      const current = await this.getMeetingType(ownerId, meetingTypeId);
      if (!current) return null;
      const values = validateMeetingType({ ...current, ...input, durationMinutes: input.durationMinutes ?? input.duration ?? current.duration });
      const rows = await client.update('meeting_types', {
        ...(input.nameAr === undefined && input.name === undefined ? {} : { name_ar: String(input.nameAr ?? input.name).trim() }),
        ...(input.nameEn === undefined && input.en === undefined ? {} : { name_en: String(input.nameEn ?? input.en).trim() }),
        ...(input.durationMinutes === undefined && input.duration === undefined ? {} : { duration_minutes: values.durationMinutes }),
        ...(input.bufferBeforeMinutes === undefined ? {} : { buffer_before_minutes: values.bufferBeforeMinutes }),
        ...(input.bufferAfterMinutes === undefined ? {} : { buffer_after_minutes: values.bufferAfterMinutes }),
        ...(input.minimumNoticeMinutes === undefined ? {} : { minimum_notice_minutes: values.minimumNoticeMinutes }),
        ...(input.bookingHorizonDays === undefined ? {} : { booking_horizon_days: values.bookingHorizonDays }),
        ...(input.mode === undefined && input.locationType === undefined ? {} : { mode: input.locationType || input.mode }),
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.active === undefined ? {} : { active: Boolean(input.active) })
      }, `?${ownerFilter(ownerId)}&id=eq.${encodeURIComponent(meetingTypeId)}`);
      return rows[0] ? mapMeetingType(rows[0]) : null;
    },
    async deactivateMeetingType(ownerId, meetingTypeId) {
      const rows = await client.update('meeting_types', { active: false }, `?${ownerFilter(ownerId)}&id=eq.${encodeURIComponent(meetingTypeId)}`);
      return rows[0] ? mapMeetingType(rows[0]) : null;
    },
    async listAvailabilitySchedules(ownerId) {
      const rows = await client.list('availability_schedules', `?${ownerFilter(ownerId)}&select=*&order=created_at.asc`);
      return rows.map(mapSchedule);
    },
    async getAvailabilitySchedule(ownerId, scheduleId) {
      const rows = await client.list('availability_schedules', `?${ownerFilter(ownerId)}&id=eq.${encodeURIComponent(scheduleId)}&select=*&limit=1`);
      return rows[0] ? mapSchedule(rows[0]) : null;
    },
    async getAvailability(ownerId) {
      const schedules = await this.listAvailabilitySchedules(ownerId);
      const schedule = schedules.find(item => item.isDefault === true) || null;
      const overrides = await this.listAvailabilityOverrides(ownerId);
      if (!schedule) return { schedule: null, intervals: [], overrides };
      const intervals = await client.list('availability_intervals', `?schedule_id=eq.${encodeURIComponent(schedule.id)}&select=*&order=weekday.asc,start_local.asc`);
      return { schedule, intervals: intervals.map(mapInterval), overrides: overrides.filter(item => !item.scheduleId || item.scheduleId === schedule.id) };
    },
    async createAvailabilitySchedule(ownerId, input) {
      const values = validateSchedule(input);
      if (values.isDefault) await client.update('availability_schedules', { is_default: false }, `?${ownerFilter(ownerId)}&is_default=eq.true`);
      const rows = await client.insert('availability_schedules', { owner_id: ownerId, name: values.name, timezone: values.timezone, is_default: values.isDefault });
      return rows[0] ? mapSchedule(rows[0]) : null;
    },
    async updateAvailabilitySchedule(ownerId, scheduleId, input) {
      const current = await this.getAvailabilitySchedule(ownerId, scheduleId);
      if (!current) return null;
      const values = validateSchedule({ name: input.name ?? current.name, timezone: input.timezone ?? current.timezone, isDefault: input.isDefault ?? current.isDefault });
      if (values.isDefault) await client.update('availability_schedules', { is_default: false }, `?${ownerFilter(ownerId)}&is_default=eq.true&id=neq.${encodeURIComponent(scheduleId)}`);
      const rows = await client.update('availability_schedules', { name: values.name, timezone: values.timezone, is_default: values.isDefault }, `?${ownerFilter(ownerId)}&id=eq.${encodeURIComponent(scheduleId)}`);
      return rows[0] ? mapSchedule(rows[0]) : null;
    },
    async deleteAvailabilitySchedule(ownerId, scheduleId) {
      const current = await this.getAvailabilitySchedule(ownerId, scheduleId);
      if (!current) return null;
      await client.remove('availability_schedules', `?${ownerFilter(ownerId)}&id=eq.${encodeURIComponent(scheduleId)}`);
      return { id: scheduleId, deleted: true };
    },
    async replaceScheduleIntervals(ownerId, scheduleId, intervals) {
      const current = await this.getAvailabilitySchedule(ownerId, scheduleId);
      if (!current) return null;
      const normalized = normalizeIntervals(intervals);
      try {
        await client.rpc('replace_availability_intervals', {
          p_owner_id: ownerId,
          p_schedule_id: scheduleId,
          p_intervals: normalized.map(item => ({ weekday: item.weekday, start_local: item.startLocal, end_local: item.endLocal }))
        });
      } catch (error) {
        const message = String(error?.message || '');
        if (/schedule was not found|ownership/i.test(message)) throw new Error('Availability schedule was not found for this owner.');
        if (/weekday|time|interval|payload|overlap|duplicate/i.test(message)) throw new Error(message.replace(/^Supabase \d+:\s*/i, ''));
        throw new Error('Availability could not be saved atomically.');
      }
      return this.getAvailability(ownerId);
    },
    async listAvailabilityOverrides(ownerId) {
      const rows = await client.list('availability_overrides', `?${ownerFilter(ownerId)}&select=*&order=override_date.asc`);
      return rows.map(mapOverride);
    },
    async createAvailabilityOverride(ownerId, input) {
      const values = normalizeOverride(input);
      const scheduleId = input.scheduleId ?? input.schedule_id ?? null;
      if (scheduleId && !(await this.getAvailabilitySchedule(ownerId, scheduleId))) return null;
      const existing = await client.list('availability_overrides', `?${ownerFilter(ownerId)}&override_date=eq.${encodeURIComponent(values.overrideDate)}&select=id&limit=1`);
      if (existing.length) throw new Error('An override already exists for this date.');
      const rows = await client.insert('availability_overrides', { owner_id: ownerId, schedule_id: scheduleId, override_date: values.overrideDate, is_available: values.isAvailable, start_local: values.startLocal, end_local: values.endLocal, reason: values.reason });
      return rows[0] ? mapOverride(rows[0]) : null;
    },
    async updateAvailabilityOverride(ownerId, overrideId, input) {
      const currentRows = await client.list('availability_overrides', `?${ownerFilter(ownerId)}&id=eq.${encodeURIComponent(overrideId)}&select=*&limit=1`);
      const current = currentRows[0] ? mapOverride(currentRows[0]) : null;
      if (!current) return null;
      const values = normalizeOverride({ overrideDate: input.overrideDate ?? current.overrideDate, isAvailable: input.isAvailable ?? current.isAvailable, startLocal: input.startLocal ?? current.startLocal, endLocal: input.endLocal ?? current.endLocal, reason: input.reason ?? current.reason });
      const duplicate = await client.list('availability_overrides', `?${ownerFilter(ownerId)}&override_date=eq.${encodeURIComponent(values.overrideDate)}&id=neq.${encodeURIComponent(overrideId)}&select=id&limit=1`);
      if (duplicate.length) throw new Error('An override already exists for this date.');
      const rows = await client.update('availability_overrides', { override_date: values.overrideDate, is_available: values.isAvailable, start_local: values.startLocal, end_local: values.endLocal, reason: values.reason }, `?${ownerFilter(ownerId)}&id=eq.${encodeURIComponent(overrideId)}`);
      return rows[0] ? mapOverride(rows[0]) : null;
    },
    async deleteAvailabilityOverride(ownerId, overrideId) {
      const currentRows = await client.list('availability_overrides', `?${ownerFilter(ownerId)}&id=eq.${encodeURIComponent(overrideId)}&select=id&limit=1`);
      if (!currentRows.length) return null;
      await client.remove('availability_overrides', `?${ownerFilter(ownerId)}&id=eq.${encodeURIComponent(overrideId)}`);
      return { id: overrideId, deleted: true };
    },
    async getPublicAvailability(ownerId) {
      return sanitizePublicAvailability(await this.getAvailability(ownerId));
    }
  };
}

function createPersistenceRepository({ backend, db, supabaseClient }) {
  if (backend === 'supabase') return createSupabaseAdapter(supabaseClient);
  if (backend === 'sqlite') return createSqliteAdapter(db);
  throw new Error(`Unsupported persistence backend: ${backend}`);
}

module.exports = { createPersistenceRepository, createSqliteAdapter, createSupabaseAdapter, publicProfile, mapMeetingType };
