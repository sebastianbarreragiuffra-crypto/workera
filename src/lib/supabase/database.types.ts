export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      absence_decisions: {
        Row: {
          absence_record_id: string
          corrected_absence_type_id: string | null
          created_at: string
          decided_at: string
          decided_by: string
          decision_status: string
          document_deadline: string | null
          document_required: boolean
          id: string
          is_current: boolean
          reason: string | null
        }
        Insert: {
          absence_record_id: string
          corrected_absence_type_id?: string | null
          created_at?: string
          decided_at?: string
          decided_by?: string
          decision_status: string
          document_deadline?: string | null
          document_required?: boolean
          id?: string
          is_current?: boolean
          reason?: string | null
        }
        Update: {
          absence_record_id?: string
          corrected_absence_type_id?: string | null
          created_at?: string
          decided_at?: string
          decided_by?: string
          decision_status?: string
          document_deadline?: string | null
          document_required?: boolean
          id?: string
          is_current?: boolean
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "absence_decisions_absence_record_id_fkey"
            columns: ["absence_record_id"]
            isOneToOne: false
            referencedRelation: "absence_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absence_decisions_corrected_absence_type_id_fkey"
            columns: ["corrected_absence_type_id"]
            isOneToOne: false
            referencedRelation: "absence_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absence_decisions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      absence_records: {
        Row: {
          absence_type_id: string
          created_at: string
          created_by: string | null
          employee_id: string
          end_date: string
          external_id: string | null
          id: string
          is_current: boolean
          source: string
          source_hash: string
          source_updated_at: string | null
          source_version: number
          start_date: string
          sync_run_id: string | null
          synced_at: string
        }
        Insert: {
          absence_type_id: string
          created_at?: string
          created_by?: string | null
          employee_id: string
          end_date: string
          external_id?: string | null
          id?: string
          is_current?: boolean
          source?: string
          source_hash: string
          source_updated_at?: string | null
          source_version?: number
          start_date: string
          sync_run_id?: string | null
          synced_at?: string
        }
        Update: {
          absence_type_id?: string
          created_at?: string
          created_by?: string | null
          employee_id?: string
          end_date?: string
          external_id?: string | null
          id?: string
          is_current?: boolean
          source?: string
          source_hash?: string
          source_updated_at?: string | null
          source_version?: number
          start_date?: string
          sync_run_id?: string | null
          synced_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "absence_records_absence_type_id_fkey"
            columns: ["absence_type_id"]
            isOneToOne: false
            referencedRelation: "absence_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absence_records_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absence_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absence_records_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      absence_types: {
        Row: {
          active: boolean
          code: string
          created_at: string
          id: string
          name: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      attendance_corrections: {
        Row: {
          attendance_record_id: string
          corrected_at: string
          corrected_by: string
          corrected_by_role: Database["public"]["Enums"]["app_role"] | null
          corrected_clock_in: string | null
          corrected_clock_out: string | null
          correction_type: string | null
          created_at: string
          employee_id: string
          id: string
          is_current: boolean
          reason: string
          work_date: string
        }
        Insert: {
          attendance_record_id: string
          corrected_at?: string
          corrected_by?: string
          corrected_by_role?: Database["public"]["Enums"]["app_role"] | null
          corrected_clock_in?: string | null
          corrected_clock_out?: string | null
          correction_type?: string | null
          created_at?: string
          employee_id: string
          id?: string
          is_current?: boolean
          reason: string
          work_date: string
        }
        Update: {
          attendance_record_id?: string
          corrected_at?: string
          corrected_by?: string
          corrected_by_role?: Database["public"]["Enums"]["app_role"] | null
          corrected_clock_in?: string | null
          corrected_clock_out?: string | null
          correction_type?: string | null
          created_at?: string
          employee_id?: string
          id?: string
          is_current?: boolean
          reason?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_corrections_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_effective_punches"
            referencedColumns: ["attendance_record_id"]
          },
          {
            foreignKeyName: "attendance_corrections_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_corrections_corrected_by_fkey"
            columns: ["corrected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_corrections_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_missing_punch_flags: {
        Row: {
          attendance_record_id: string
          contacted_at: string | null
          contacted_by: string | null
          created_at: string
          employee_id: string
          id: string
          missing_type: Database["public"]["Enums"]["missing_punch_type"]
          notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: Database["public"]["Enums"]["missing_punch_status"]
          updated_at: string
          work_date: string
        }
        Insert: {
          attendance_record_id: string
          contacted_at?: string | null
          contacted_by?: string | null
          created_at?: string
          employee_id: string
          id?: string
          missing_type: Database["public"]["Enums"]["missing_punch_type"]
          notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["missing_punch_status"]
          updated_at?: string
          work_date: string
        }
        Update: {
          attendance_record_id?: string
          contacted_at?: string | null
          contacted_by?: string | null
          created_at?: string
          employee_id?: string
          id?: string
          missing_type?: Database["public"]["Enums"]["missing_punch_type"]
          notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["missing_punch_status"]
          updated_at?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_missing_punch_flags_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: true
            referencedRelation: "attendance_effective_punches"
            referencedColumns: ["attendance_record_id"]
          },
          {
            foreignKeyName: "attendance_missing_punch_flags_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: true
            referencedRelation: "attendance_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_missing_punch_flags_contacted_by_fkey"
            columns: ["contacted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_missing_punch_flags_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_missing_punch_flags_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_records: {
        Row: {
          actual_clock_in: string | null
          actual_clock_out: string | null
          created_at: string
          employee_id: string
          external_id: string | null
          id: string
          is_current: boolean
          source: string
          source_hash: string
          source_updated_at: string | null
          source_version: number
          sync_run_id: string | null
          synced_at: string
          work_date: string
        }
        Insert: {
          actual_clock_in?: string | null
          actual_clock_out?: string | null
          created_at?: string
          employee_id: string
          external_id?: string | null
          id?: string
          is_current?: boolean
          source?: string
          source_hash: string
          source_updated_at?: string | null
          source_version?: number
          sync_run_id?: string | null
          synced_at?: string
          work_date: string
        }
        Update: {
          actual_clock_in?: string | null
          actual_clock_out?: string | null
          created_at?: string
          employee_id?: string
          external_id?: string | null
          id?: string
          is_current?: boolean
          source?: string
          source_hash?: string
          source_updated_at?: string | null
          source_version?: number
          sync_run_id?: string | null
          synced_at?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_records_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_status_records: {
        Row: {
          attendance_status_id: string
          created_at: string
          created_by: string | null
          employee_id: string
          external_id: string | null
          id: string
          is_current: boolean
          reason: string | null
          source: string
          source_hash: string
          source_updated_at: string | null
          source_version: number
          sync_run_id: string | null
          synced_at: string
          work_date: string
        }
        Insert: {
          attendance_status_id: string
          created_at?: string
          created_by?: string | null
          employee_id: string
          external_id?: string | null
          id?: string
          is_current?: boolean
          reason?: string | null
          source: string
          source_hash: string
          source_updated_at?: string | null
          source_version?: number
          sync_run_id?: string | null
          synced_at?: string
          work_date: string
        }
        Update: {
          attendance_status_id?: string
          created_at?: string
          created_by?: string | null
          employee_id?: string
          external_id?: string | null
          id?: string
          is_current?: boolean
          reason?: string | null
          source?: string
          source_hash?: string
          source_updated_at?: string | null
          source_version?: number
          sync_run_id?: string | null
          synced_at?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_status_records_attendance_status_id_fkey"
            columns: ["attendance_status_id"]
            isOneToOne: false
            referencedRelation: "attendance_statuses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_status_records_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_status_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_status_records_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_statuses: {
        Row: {
          active: boolean
          category: string
          code: string
          created_at: string
          id: string
          name: string
          requires_review: boolean
        }
        Insert: {
          active?: boolean
          category: string
          code: string
          created_at?: string
          id?: string
          name: string
          requires_review?: boolean
        }
        Update: {
          active?: boolean
          category?: string
          code?: string
          created_at?: string
          id?: string
          name?: string
          requires_review?: boolean
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          entity_id: string
          entity_type: string
          id: string
          metadata: Json | null
          occurred_at: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          entity_id: string
          entity_type: string
          id?: string
          metadata?: Json | null
          occurred_at?: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          entity_id?: string
          entity_type?: string
          id?: string
          metadata?: Json | null
          occurred_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      authorized_email_roles: {
        Row: {
          created_at: string
          email: string
          role: Database["public"]["Enums"]["app_role"]
        }
        Insert: {
          created_at?: string
          email: string
          role: Database["public"]["Enums"]["app_role"]
        }
        Update: {
          created_at?: string
          email?: string
          role?: Database["public"]["Enums"]["app_role"]
        }
        Relationships: []
      }
      bonus_policies: {
        Row: {
          amount: number
          bonus_type_id: string
          created_at: string
          currency: string
          effective_from: string
          effective_to: string | null
          employee_group_id: string
          id: string
          threshold_minutes: number | null
          trigger_type: string
        }
        Insert: {
          amount: number
          bonus_type_id: string
          created_at?: string
          currency?: string
          effective_from: string
          effective_to?: string | null
          employee_group_id: string
          id?: string
          threshold_minutes?: number | null
          trigger_type: string
        }
        Update: {
          amount?: number
          bonus_type_id?: string
          created_at?: string
          currency?: string
          effective_from?: string
          effective_to?: string | null
          employee_group_id?: string
          id?: string
          threshold_minutes?: number | null
          trigger_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "bonus_policies_bonus_type_id_fkey"
            columns: ["bonus_type_id"]
            isOneToOne: false
            referencedRelation: "bonus_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bonus_policies_employee_group_id_fkey"
            columns: ["employee_group_id"]
            isOneToOne: false
            referencedRelation: "employee_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      bonus_types: {
        Row: {
          active: boolean
          code: string
          created_at: string
          id: string
          name: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      colaciones_discount_workbooks: {
        Row: {
          active: boolean
          checksum: string
          created_at: string
          file_size: number
          id: string
          original_filename: string
          storage_path: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          active?: boolean
          checksum: string
          created_at?: string
          file_size: number
          id?: string
          original_filename: string
          storage_path: string
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          active?: boolean
          checksum?: string
          created_at?: string
          file_size?: number
          id?: string
          original_filename?: string
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "colaciones_discount_workbooks_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          active: boolean
          created_at: string
          id: string
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      company_memberships: {
        Row: {
          active: boolean
          company_id: string
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          company_id: string
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          company_id?: string
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_memberships_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_reviews: {
        Row: {
          created_at: string
          employee_id: string
          id: string
          status: Database["public"]["Enums"]["daily_review_status"]
          updated_at: string
          weekly_review_id: string | null
          work_date: string
        }
        Insert: {
          created_at?: string
          employee_id: string
          id?: string
          status?: Database["public"]["Enums"]["daily_review_status"]
          updated_at?: string
          weekly_review_id?: string | null
          work_date: string
        }
        Update: {
          created_at?: string
          employee_id?: string
          id?: string
          status?: Database["public"]["Enums"]["daily_review_status"]
          updated_at?: string
          weekly_review_id?: string | null
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_reviews_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_reviews_weekly_review_id_fkey"
            columns: ["weekly_review_id"]
            isOneToOne: false
            referencedRelation: "weekly_reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      early_departure_decisions: {
        Row: {
          created_at: string
          decided_at: string
          decided_by: string
          document_deadline: string | null
          document_required: boolean
          early_departure_record_id: string
          id: string
          is_current: boolean
          payroll_effect: string
          payroll_minutes: number
          reason: string | null
          reason_category: string
        }
        Insert: {
          created_at?: string
          decided_at?: string
          decided_by?: string
          document_deadline?: string | null
          document_required?: boolean
          early_departure_record_id: string
          id?: string
          is_current?: boolean
          payroll_effect: string
          payroll_minutes: number
          reason?: string | null
          reason_category: string
        }
        Update: {
          created_at?: string
          decided_at?: string
          decided_by?: string
          document_deadline?: string | null
          document_required?: boolean
          early_departure_record_id?: string
          id?: string
          is_current?: boolean
          payroll_effect?: string
          payroll_minutes?: number
          reason?: string | null
          reason_category?: string
        }
        Relationships: [
          {
            foreignKeyName: "early_departure_decisions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "early_departure_decisions_early_departure_record_id_fkey"
            columns: ["early_departure_record_id"]
            isOneToOne: false
            referencedRelation: "early_departure_records"
            referencedColumns: ["id"]
          },
        ]
      }
      early_departure_records: {
        Row: {
          actual_end: string
          attendance_record_id: string
          calculated_at: string
          calculation_version: number
          created_at: string
          detected_minutes: number
          employee_id: string
          id: string
          is_current: boolean
          scheduled_end: string
          work_date: string
        }
        Insert: {
          actual_end: string
          attendance_record_id: string
          calculated_at?: string
          calculation_version?: number
          created_at?: string
          detected_minutes: number
          employee_id: string
          id?: string
          is_current?: boolean
          scheduled_end: string
          work_date: string
        }
        Update: {
          actual_end?: string
          attendance_record_id?: string
          calculated_at?: string
          calculation_version?: number
          created_at?: string
          detected_minutes?: number
          employee_id?: string
          id?: string
          is_current?: boolean
          scheduled_end?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "early_departure_records_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_effective_punches"
            referencedColumns: ["attendance_record_id"]
          },
          {
            foreignKeyName: "early_departure_records_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "early_departure_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_birthdays: {
        Row: {
          birth_day: number
          birth_month: number
          created_at: string
          created_by: string | null
          employee_id: string
          id: string
          imported_at: string
        }
        Insert: {
          birth_day: number
          birth_month: number
          created_at?: string
          created_by?: string | null
          employee_id: string
          id?: string
          imported_at?: string
        }
        Update: {
          birth_day?: number
          birth_month?: number
          created_at?: string
          created_by?: string | null
          employee_id?: string
          id?: string
          imported_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_birthdays_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_birthdays_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: true
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_daily_bonuses: {
        Row: {
          amount: number
          bonus_policy_id: string
          created_at: string
          currency: string
          employee_id: string
          granted_at: string
          id: string
          overtime_decision_id: string
          work_date: string
        }
        Insert: {
          amount: number
          bonus_policy_id: string
          created_at?: string
          currency?: string
          employee_id: string
          granted_at?: string
          id?: string
          overtime_decision_id: string
          work_date: string
        }
        Update: {
          amount?: number
          bonus_policy_id?: string
          created_at?: string
          currency?: string
          employee_id?: string
          granted_at?: string
          id?: string
          overtime_decision_id?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_daily_bonuses_bonus_policy_id_fkey"
            columns: ["bonus_policy_id"]
            isOneToOne: false
            referencedRelation: "bonus_policies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_daily_bonuses_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_daily_bonuses_overtime_decision_id_fkey"
            columns: ["overtime_decision_id"]
            isOneToOne: true
            referencedRelation: "overtime_decisions"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_group_assignments: {
        Row: {
          created_at: string
          effective_from: string
          effective_to: string | null
          employee_group_id: string
          employee_id: string
          id: string
          source: string
          sync_run_id: string | null
        }
        Insert: {
          created_at?: string
          effective_from: string
          effective_to?: string | null
          employee_group_id: string
          employee_id: string
          id?: string
          source?: string
          sync_run_id?: string | null
        }
        Update: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          employee_group_id?: string
          employee_id?: string
          id?: string
          source?: string
          sync_run_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employee_group_assignments_employee_group_id_fkey"
            columns: ["employee_group_id"]
            isOneToOne: false
            referencedRelation: "employee_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_group_assignments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_group_assignments_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_groups: {
        Row: {
          active: boolean
          code: string
          created_at: string
          id: string
          name: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      employee_time_control_policies: {
        Row: {
          created_at: string
          created_by: string
          effective_from: string
          effective_to: string | null
          employee_id: string
          id: string
          legal_basis: string | null
          policy_code: string
          reason: string | null
        }
        Insert: {
          created_at?: string
          created_by: string
          effective_from: string
          effective_to?: string | null
          employee_id: string
          id?: string
          legal_basis?: string | null
          policy_code: string
          reason?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string
          effective_from?: string
          effective_to?: string | null
          employee_id?: string
          id?: string
          legal_basis?: string | null
          policy_code?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employee_time_control_policies_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_time_control_policies_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      employees: {
        Row: {
          active: boolean
          created_at: string
          display_name: string
          employee_group_id: string | null
          external_workera_id: string
          first_name: string
          hire_date: string | null
          id: string
          last_name: string
          rut: string | null
          source: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          display_name: string
          employee_group_id?: string | null
          external_workera_id: string
          first_name: string
          hire_date?: string | null
          id?: string
          last_name: string
          rut?: string | null
          source?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          display_name?: string
          employee_group_id?: string | null
          external_workera_id?: string
          first_name?: string
          hire_date?: string | null
          id?: string
          last_name?: string
          rut?: string | null
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employees_employee_group_id_fkey"
            columns: ["employee_group_id"]
            isOneToOne: false
            referencedRelation: "employee_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      excel_exports: {
        Row: {
          created_at: string
          export_scope: string
          file_hash: string | null
          generated_at: string
          generated_by: string
          id: string
          period_snapshot_id: string | null
          reporting_period_id: string | null
          snapshot_id: string | null
          storage_path: string | null
          template_version: string
          validation_status: string
          weekly_review_id: string | null
        }
        Insert: {
          created_at?: string
          export_scope?: string
          file_hash?: string | null
          generated_at?: string
          generated_by?: string
          id?: string
          period_snapshot_id?: string | null
          reporting_period_id?: string | null
          snapshot_id?: string | null
          storage_path?: string | null
          template_version: string
          validation_status: string
          weekly_review_id?: string | null
        }
        Update: {
          created_at?: string
          export_scope?: string
          file_hash?: string | null
          generated_at?: string
          generated_by?: string
          id?: string
          period_snapshot_id?: string | null
          reporting_period_id?: string | null
          snapshot_id?: string | null
          storage_path?: string | null
          template_version?: string
          validation_status?: string
          weekly_review_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "excel_exports_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excel_exports_period_snapshot_id_fkey"
            columns: ["period_snapshot_id"]
            isOneToOne: false
            referencedRelation: "period_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excel_exports_reporting_period_id_fkey"
            columns: ["reporting_period_id"]
            isOneToOne: false
            referencedRelation: "reporting_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excel_exports_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "weekly_review_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excel_exports_weekly_review_id_fkey"
            columns: ["weekly_review_id"]
            isOneToOne: false
            referencedRelation: "weekly_reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      holidays: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          holiday_date: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          holiday_date: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          holiday_date?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "holidays_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      late_arrival_decisions: {
        Row: {
          created_at: string
          decided_at: string
          decided_by: string
          id: string
          is_current: boolean
          justification_status: string | null
          justified: boolean
          late_arrival_record_id: string
          payroll_effect: string
          payroll_minutes: number
          reason: string | null
        }
        Insert: {
          created_at?: string
          decided_at?: string
          decided_by?: string
          id?: string
          is_current?: boolean
          justification_status?: string | null
          justified: boolean
          late_arrival_record_id: string
          payroll_effect: string
          payroll_minutes: number
          reason?: string | null
        }
        Update: {
          created_at?: string
          decided_at?: string
          decided_by?: string
          id?: string
          is_current?: boolean
          justification_status?: string | null
          justified?: boolean
          late_arrival_record_id?: string
          payroll_effect?: string
          payroll_minutes?: number
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "late_arrival_decisions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "late_arrival_decisions_late_arrival_record_id_fkey"
            columns: ["late_arrival_record_id"]
            isOneToOne: false
            referencedRelation: "late_arrival_records"
            referencedColumns: ["id"]
          },
        ]
      }
      late_arrival_policies: {
        Row: {
          created_at: string
          day_of_week: number
          effective_from: string
          effective_to: string | null
          employee_group_id: string
          id: string
          tolerance_minutes: number
        }
        Insert: {
          created_at?: string
          day_of_week: number
          effective_from: string
          effective_to?: string | null
          employee_group_id: string
          id?: string
          tolerance_minutes?: number
        }
        Update: {
          created_at?: string
          day_of_week?: number
          effective_from?: string
          effective_to?: string | null
          employee_group_id?: string
          id?: string
          tolerance_minutes?: number
        }
        Relationships: [
          {
            foreignKeyName: "late_arrival_policies_employee_group_id_fkey"
            columns: ["employee_group_id"]
            isOneToOne: false
            referencedRelation: "employee_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      late_arrival_records: {
        Row: {
          actual_start: string
          attendance_record_id: string
          calculated_at: string
          calculation_version: number
          created_at: string
          detected_minutes: number
          employee_id: string
          id: string
          is_current: boolean
          late_arrival_policy_id: string
          scheduled_start: string
          work_date: string
        }
        Insert: {
          actual_start: string
          attendance_record_id: string
          calculated_at?: string
          calculation_version?: number
          created_at?: string
          detected_minutes: number
          employee_id: string
          id?: string
          is_current?: boolean
          late_arrival_policy_id: string
          scheduled_start: string
          work_date: string
        }
        Update: {
          actual_start?: string
          attendance_record_id?: string
          calculated_at?: string
          calculation_version?: number
          created_at?: string
          detected_minutes?: number
          employee_id?: string
          id?: string
          is_current?: boolean
          late_arrival_policy_id?: string
          scheduled_start?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "late_arrival_records_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_effective_punches"
            referencedColumns: ["attendance_record_id"]
          },
          {
            foreignKeyName: "late_arrival_records_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "late_arrival_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "late_arrival_records_late_arrival_policy_id_fkey"
            columns: ["late_arrival_policy_id"]
            isOneToOne: false
            referencedRelation: "late_arrival_policies"
            referencedColumns: ["id"]
          },
        ]
      }
      medical_license_approvals: {
        Row: {
          absence_record_id: string
          approved_at: string | null
          approved_by: string | null
          confirmed_end_date: string | null
          confirmed_start_date: string | null
          created_at: string
          extraction_status: string | null
          id: string
          is_current: boolean
          proposed_end_date: string
          proposed_start_date: string
          rejected_at: string | null
          rejected_by: string | null
          rejection_reason: string | null
          status: Database["public"]["Enums"]["medical_license_approval_status"]
          supporting_document_id: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          absence_record_id: string
          approved_at?: string | null
          approved_by?: string | null
          confirmed_end_date?: string | null
          confirmed_start_date?: string | null
          created_at?: string
          extraction_status?: string | null
          id?: string
          is_current?: boolean
          proposed_end_date: string
          proposed_start_date: string
          rejected_at?: string | null
          rejected_by?: string | null
          rejection_reason?: string | null
          status?: Database["public"]["Enums"]["medical_license_approval_status"]
          supporting_document_id: string
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          absence_record_id?: string
          approved_at?: string | null
          approved_by?: string | null
          confirmed_end_date?: string | null
          confirmed_start_date?: string | null
          created_at?: string
          extraction_status?: string | null
          id?: string
          is_current?: boolean
          proposed_end_date?: string
          proposed_start_date?: string
          rejected_at?: string | null
          rejected_by?: string | null
          rejection_reason?: string | null
          status?: Database["public"]["Enums"]["medical_license_approval_status"]
          supporting_document_id?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "medical_license_approvals_absence_record_id_fkey"
            columns: ["absence_record_id"]
            isOneToOne: false
            referencedRelation: "absence_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_license_approvals_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_license_approvals_rejected_by_fkey"
            columns: ["rejected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_license_approvals_supporting_document_id_fkey"
            columns: ["supporting_document_id"]
            isOneToOne: false
            referencedRelation: "supporting_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_license_approvals_supporting_document_id_fkey"
            columns: ["supporting_document_id"]
            isOneToOne: false
            referencedRelation: "supporting_documents_metadata"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_license_approvals_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      overtime_decisions: {
        Row: {
          approved_minutes: number
          created_at: string
          decided_at: string
          decided_by: string
          decision_status: Database["public"]["Enums"]["overtime_decision_status"]
          id: string
          is_current: boolean
          overtime_record_id: string
          reason: string | null
          rejected_minutes: number
          requires_manual_review: boolean
          system_proposed_minutes: number | null
        }
        Insert: {
          approved_minutes: number
          created_at?: string
          decided_at?: string
          decided_by?: string
          decision_status: Database["public"]["Enums"]["overtime_decision_status"]
          id?: string
          is_current?: boolean
          overtime_record_id: string
          reason?: string | null
          rejected_minutes: number
          requires_manual_review?: boolean
          system_proposed_minutes?: number | null
        }
        Update: {
          approved_minutes?: number
          created_at?: string
          decided_at?: string
          decided_by?: string
          decision_status?: Database["public"]["Enums"]["overtime_decision_status"]
          id?: string
          is_current?: boolean
          overtime_record_id?: string
          reason?: string | null
          rejected_minutes?: number
          requires_manual_review?: boolean
          system_proposed_minutes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "overtime_decisions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "overtime_decisions_overtime_record_id_fkey"
            columns: ["overtime_record_id"]
            isOneToOne: false
            referencedRelation: "overtime_records"
            referencedColumns: ["id"]
          },
        ]
      }
      overtime_policies: {
        Row: {
          created_at: string
          day_of_week: number
          effective_from: string
          effective_to: string | null
          employee_group_id: string
          id: string
          max_overtime_minutes: number | null
          overtime_eligible: boolean
        }
        Insert: {
          created_at?: string
          day_of_week: number
          effective_from: string
          effective_to?: string | null
          employee_group_id: string
          id?: string
          max_overtime_minutes?: number | null
          overtime_eligible: boolean
        }
        Update: {
          created_at?: string
          day_of_week?: number
          effective_from?: string
          effective_to?: string | null
          employee_group_id?: string
          id?: string
          max_overtime_minutes?: number | null
          overtime_eligible?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "overtime_policies_employee_group_id_fkey"
            columns: ["employee_group_id"]
            isOneToOne: false
            referencedRelation: "employee_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      overtime_records: {
        Row: {
          attendance_record_id: string
          calculated_at: string
          calculation_version: number
          candidate_minutes: number
          created_at: string
          employee_id: string
          id: string
          is_current: boolean
          overtime_policy_id: string
          overtime_type_id: string
          work_date: string
        }
        Insert: {
          attendance_record_id: string
          calculated_at?: string
          calculation_version?: number
          candidate_minutes: number
          created_at?: string
          employee_id: string
          id?: string
          is_current?: boolean
          overtime_policy_id: string
          overtime_type_id: string
          work_date: string
        }
        Update: {
          attendance_record_id?: string
          calculated_at?: string
          calculation_version?: number
          candidate_minutes?: number
          created_at?: string
          employee_id?: string
          id?: string
          is_current?: boolean
          overtime_policy_id?: string
          overtime_type_id?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "overtime_records_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_effective_punches"
            referencedColumns: ["attendance_record_id"]
          },
          {
            foreignKeyName: "overtime_records_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "overtime_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "overtime_records_overtime_policy_id_fkey"
            columns: ["overtime_policy_id"]
            isOneToOne: false
            referencedRelation: "overtime_policies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "overtime_records_overtime_type_id_fkey"
            columns: ["overtime_type_id"]
            isOneToOne: false
            referencedRelation: "overtime_types"
            referencedColumns: ["id"]
          },
        ]
      }
      overtime_types: {
        Row: {
          active: boolean
          code: string
          created_at: string
          id: string
          name: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      payroll_batch_items: {
        Row: {
          batch_id: string
          created_at: string
          id: string
          nombre_cliente: string
          nro_docto: string
          status: string
          supplier_id: string | null
          valor_total: number
        }
        Insert: {
          batch_id: string
          created_at?: string
          id?: string
          nombre_cliente: string
          nro_docto: string
          status: string
          supplier_id?: string | null
          valor_total: number
        }
        Update: {
          batch_id?: string
          created_at?: string
          id?: string
          nombre_cliente?: string
          nro_docto?: string
          status?: string
          supplier_id?: string | null
          valor_total?: number
        }
        Relationships: [
          {
            foreignKeyName: "payroll_batch_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "payroll_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_batch_items_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll_batches: {
        Row: {
          generated_at: string
          generated_by: string
          id: string
          matched_count: number
          source_filename: string
          total_amount: number
          unmatched_count: number
        }
        Insert: {
          generated_at?: string
          generated_by: string
          id?: string
          matched_count: number
          source_filename: string
          total_amount: number
          unmatched_count: number
        }
        Update: {
          generated_at?: string
          generated_by?: string
          id?: string
          matched_count?: number
          source_filename?: string
          total_amount?: number
          unmatched_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "payroll_batches_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      period_snapshots: {
        Row: {
          created_at: string
          generated_at: string
          generated_by: string
          id: string
          payload: Json
          reporting_period_id: string
        }
        Insert: {
          created_at?: string
          generated_at?: string
          generated_by?: string
          id?: string
          payload: Json
          reporting_period_id: string
        }
        Update: {
          created_at?: string
          generated_at?: string
          generated_by?: string
          id?: string
          payload?: Json
          reporting_period_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "period_snapshots_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "period_snapshots_reporting_period_id_fkey"
            columns: ["reporting_period_id"]
            isOneToOne: false
            referencedRelation: "reporting_periods"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          active: boolean
          created_at: string
          display_name: string
          id: string
          medical_license_approver: boolean
          role: Database["public"]["Enums"]["app_role"] | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          display_name: string
          id?: string
          medical_license_approver?: boolean
          role?: Database["public"]["Enums"]["app_role"] | null
        }
        Update: {
          active?: boolean
          created_at?: string
          display_name?: string
          id?: string
          medical_license_approver?: boolean
          role?: Database["public"]["Enums"]["app_role"] | null
        }
        Relationships: []
      }
      reporting_periods: {
        Row: {
          closed_at: string | null
          closed_by: string | null
          created_at: string
          id: string
          period_end: string
          period_start: string
          reopen_reason: string | null
          reopened_at: string | null
          reopened_by: string | null
          status: Database["public"]["Enums"]["reporting_period_status"]
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          period_end: string
          period_start: string
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          status?: Database["public"]["Enums"]["reporting_period_status"]
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          period_end?: string
          period_start?: string
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          status?: Database["public"]["Enums"]["reporting_period_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reporting_periods_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reporting_periods_reopened_by_fkey"
            columns: ["reopened_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_assignments: {
        Row: {
          created_at: string
          effective_from: string
          effective_to: string | null
          employee_id: string
          id: string
          work_schedule_id: string
        }
        Insert: {
          created_at?: string
          effective_from: string
          effective_to?: string | null
          employee_id: string
          id?: string
          work_schedule_id: string
        }
        Update: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          employee_id?: string
          id?: string
          work_schedule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_assignments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_assignments_work_schedule_id_fkey"
            columns: ["work_schedule_id"]
            isOneToOne: false
            referencedRelation: "work_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      supervisor_assignments: {
        Row: {
          created_at: string
          effective_from: string
          effective_to: string | null
          employee_id: string
          id: string
          source: string
          supervisor_profile_id: string
        }
        Insert: {
          created_at?: string
          effective_from: string
          effective_to?: string | null
          employee_id: string
          id?: string
          source?: string
          supervisor_profile_id: string
        }
        Update: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          employee_id?: string
          id?: string
          source?: string
          supervisor_profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "supervisor_assignments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supervisor_assignments_supervisor_profile_id_fkey"
            columns: ["supervisor_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_master_imports: {
        Row: {
          activated_at: string | null
          created_at: string
          file_size: number
          id: string
          inserted_count: number
          original_filename: string
          rejected_count: number
          replaced_at: string | null
          replaces_import_id: string | null
          row_count: number
          status: Database["public"]["Enums"]["supplier_master_import_status"]
          storage_path: string | null
          unchanged_count: number
          updated_count: number
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          activated_at?: string | null
          created_at?: string
          file_size: number
          id?: string
          inserted_count?: number
          original_filename: string
          rejected_count?: number
          replaced_at?: string | null
          replaces_import_id?: string | null
          row_count: number
          status?: Database["public"]["Enums"]["supplier_master_import_status"]
          storage_path?: string | null
          unchanged_count?: number
          updated_count?: number
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          activated_at?: string | null
          created_at?: string
          file_size?: number
          id?: string
          inserted_count?: number
          original_filename?: string
          rejected_count?: number
          replaced_at?: string | null
          replaces_import_id?: string | null
          row_count?: number
          status?: Database["public"]["Enums"]["supplier_master_import_status"]
          storage_path?: string | null
          unchanged_count?: number
          updated_count?: number
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_master_imports_replaces_import_id_fkey"
            columns: ["replaces_import_id"]
            isOneToOne: false
            referencedRelation: "supplier_master_imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_master_imports_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          account_number: string
          active: boolean
          bank_code: string
          created_at: string
          created_by: string
          id: string
          name: string
          normalized_name: string
          normalized_rut: string
          payment_method: string
          rut: string
          updated_at: string
        }
        Insert: {
          account_number: string
          active?: boolean
          bank_code: string
          created_at?: string
          created_by: string
          id?: string
          name: string
          normalized_name: string
          normalized_rut: string
          payment_method: string
          rut: string
          updated_at?: string
        }
        Update: {
          account_number?: string
          active?: boolean
          bank_code?: string
          created_at?: string
          created_by?: string
          id?: string
          name?: string
          normalized_name?: string
          normalized_rut?: string
          payment_method?: string
          rut?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "suppliers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      supporting_documents: {
        Row: {
          absence_record_id: string | null
          attendance_status_record_id: string | null
          created_at: string
          document_type: string
          early_departure_record_id: string | null
          employee_id: string
          id: string
          late_arrival_decision_id: string | null
          mime_type: string
          original_filename: string
          storage_path: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          absence_record_id?: string | null
          attendance_status_record_id?: string | null
          created_at?: string
          document_type: string
          early_departure_record_id?: string | null
          employee_id: string
          id?: string
          late_arrival_decision_id?: string | null
          mime_type: string
          original_filename: string
          storage_path: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Update: {
          absence_record_id?: string | null
          attendance_status_record_id?: string | null
          created_at?: string
          document_type?: string
          early_departure_record_id?: string | null
          employee_id?: string
          id?: string
          late_arrival_decision_id?: string | null
          mime_type?: string
          original_filename?: string
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "supporting_documents_absence_record_id_fkey"
            columns: ["absence_record_id"]
            isOneToOne: false
            referencedRelation: "absence_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_attendance_status_record_id_fkey"
            columns: ["attendance_status_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_status_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_early_departure_record_id_fkey"
            columns: ["early_departure_record_id"]
            isOneToOne: false
            referencedRelation: "early_departure_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_late_arrival_decision_id_fkey"
            columns: ["late_arrival_decision_id"]
            isOneToOne: false
            referencedRelation: "late_arrival_decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_runs: {
        Row: {
          attempt: number
          created_at: string
          error_category: string | null
          error_summary: Json | null
          finished_at: string | null
          id: string
          records_conflicted: number
          records_created: number
          records_read: number
          records_unchanged: number
          records_updated: number
          retry_of: string | null
          started_at: string
          status: Database["public"]["Enums"]["sync_run_status"]
          target_period_end: string | null
          target_period_start: string | null
          triggered_by: string
        }
        Insert: {
          attempt?: number
          created_at?: string
          error_category?: string | null
          error_summary?: Json | null
          finished_at?: string | null
          id?: string
          records_conflicted?: number
          records_created?: number
          records_read?: number
          records_unchanged?: number
          records_updated?: number
          retry_of?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["sync_run_status"]
          target_period_end?: string | null
          target_period_start?: string | null
          triggered_by?: string
        }
        Update: {
          attempt?: number
          created_at?: string
          error_category?: string | null
          error_summary?: Json | null
          finished_at?: string | null
          id?: string
          records_conflicted?: number
          records_created?: number
          records_read?: number
          records_unchanged?: number
          records_updated?: number
          retry_of?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["sync_run_status"]
          target_period_end?: string | null
          target_period_start?: string | null
          triggered_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_runs_retry_of_fkey"
            columns: ["retry_of"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      weekly_review_snapshots: {
        Row: {
          created_at: string
          generated_at: string
          generated_by: string
          id: string
          payload: Json
          weekly_review_id: string
        }
        Insert: {
          created_at?: string
          generated_at?: string
          generated_by?: string
          id?: string
          payload: Json
          weekly_review_id: string
        }
        Update: {
          created_at?: string
          generated_at?: string
          generated_by?: string
          id?: string
          payload?: Json
          weekly_review_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "weekly_review_snapshots_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weekly_review_snapshots_weekly_review_id_fkey"
            columns: ["weekly_review_id"]
            isOneToOne: false
            referencedRelation: "weekly_reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      weekly_reviews: {
        Row: {
          closed_at: string | null
          closed_by: string | null
          created_at: string
          id: string
          period_end: string
          period_start: string
          reopen_reason: string | null
          reopened_at: string | null
          reopened_by: string | null
          reporting_period_id: string | null
          status: Database["public"]["Enums"]["weekly_review_status"]
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          period_end: string
          period_start: string
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          reporting_period_id?: string | null
          status?: Database["public"]["Enums"]["weekly_review_status"]
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          period_end?: string
          period_start?: string
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          reporting_period_id?: string | null
          status?: Database["public"]["Enums"]["weekly_review_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "weekly_reviews_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weekly_reviews_reopened_by_fkey"
            columns: ["reopened_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weekly_reviews_reporting_period_id_fkey"
            columns: ["reporting_period_id"]
            isOneToOne: false
            referencedRelation: "reporting_periods"
            referencedColumns: ["id"]
          },
        ]
      }
      work_schedule_rules: {
        Row: {
          created_at: string
          day_of_week: number
          id: string
          scheduled_end: string | null
          scheduled_start: string | null
          work_schedule_id: string
        }
        Insert: {
          created_at?: string
          day_of_week: number
          id?: string
          scheduled_end?: string | null
          scheduled_start?: string | null
          work_schedule_id: string
        }
        Update: {
          created_at?: string
          day_of_week?: number
          id?: string
          scheduled_end?: string | null
          scheduled_start?: string | null
          work_schedule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_schedule_rules_work_schedule_id_fkey"
            columns: ["work_schedule_id"]
            isOneToOne: false
            referencedRelation: "work_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      work_schedules: {
        Row: {
          active: boolean
          created_at: string
          id: string
          name: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      workera_attendance_events: {
        Row: {
          attendance_status: string
          attendance_timestamp_interpreted: string | null
          attendance_timestamp_raw: string
          attendance_type_code: number
          attendance_type_label: string
          checksum: string | null
          created_at: string
          device_name: string | null
          employee_id: string
          external_attendance_status: string
          external_employee_code: string
          external_fingerprint: string | null
          id: string
          is_current: boolean
          origin: string | null
          origin_code: string | null
          source_version: number
          sync_run_id: string
          synced_at: string
          work_date: string
        }
        Insert: {
          attendance_status: string
          attendance_timestamp_interpreted?: string | null
          attendance_timestamp_raw: string
          attendance_type_code: number
          attendance_type_label: string
          checksum?: string | null
          created_at?: string
          device_name?: string | null
          employee_id: string
          external_attendance_status: string
          external_employee_code: string
          external_fingerprint?: string | null
          id?: string
          is_current?: boolean
          origin?: string | null
          origin_code?: string | null
          source_version?: number
          sync_run_id: string
          synced_at?: string
          work_date: string
        }
        Update: {
          attendance_status?: string
          attendance_timestamp_interpreted?: string | null
          attendance_timestamp_raw?: string
          attendance_type_code?: number
          attendance_type_label?: string
          checksum?: string | null
          created_at?: string
          device_name?: string | null
          employee_id?: string
          external_attendance_status?: string
          external_employee_code?: string
          external_fingerprint?: string | null
          id?: string
          is_current?: boolean
          origin?: string | null
          origin_code?: string | null
          source_version?: number
          sync_run_id?: string
          synced_at?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "workera_attendance_events_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workera_attendance_events_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      attendance_effective_punches: {
        Row: {
          attendance_record_id: string | null
          current_correction_id: string | null
          effective_clock_in: string | null
          effective_clock_out: string | null
          employee_id: string | null
          raw_clock_in: string | null
          raw_clock_out: string | null
          work_date: string | null
        }
        Relationships: [
          {
            foreignKeyName: "attendance_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      late_arrival_daily_totals: {
        Row: {
          detected_minutes: number | null
          employee_id: string | null
          justification_status: string | null
          payroll_minutes: number | null
          work_date: string | null
        }
        Relationships: [
          {
            foreignKeyName: "late_arrival_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      supporting_documents_metadata: {
        Row: {
          absence_record_id: string | null
          attendance_status_record_id: string | null
          created_at: string | null
          document_type: string | null
          employee_id: string | null
          id: string | null
          late_arrival_decision_id: string | null
          mime_type: string | null
          original_filename: string | null
          uploaded_at: string | null
          uploaded_by: string | null
        }
        Insert: {
          absence_record_id?: string | null
          attendance_status_record_id?: string | null
          created_at?: string | null
          document_type?: string | null
          employee_id?: string | null
          id?: string | null
          late_arrival_decision_id?: string | null
          mime_type?: string | null
          original_filename?: string | null
          uploaded_at?: string | null
          uploaded_by?: string | null
        }
        Update: {
          absence_record_id?: string | null
          attendance_status_record_id?: string | null
          created_at?: string | null
          document_type?: string | null
          employee_id?: string | null
          id?: string | null
          late_arrival_decision_id?: string | null
          mime_type?: string | null
          original_filename?: string | null
          uploaded_at?: string | null
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "supporting_documents_absence_record_id_fkey"
            columns: ["absence_record_id"]
            isOneToOne: false
            referencedRelation: "absence_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_attendance_status_record_id_fkey"
            columns: ["attendance_status_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_status_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_late_arrival_decision_id_fkey"
            columns: ["late_arrival_decision_id"]
            isOneToOne: false
            referencedRelation: "late_arrival_decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      activate_colaciones_discount_workbook: {
        Args: {
          p_checksum: string
          p_file_size: number
          p_id: string
          p_original_filename: string
          p_storage_path: string
          p_uploaded_by: string
        }
        Returns: undefined
      }
      active_company_memberships: {
        Args: never
        Returns: {
          active: boolean
          company_id: string
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "company_memberships"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      apply_personnel_roster_import: {
        Args: {
          p_actor_id: string
          p_deactivate_ids: Json
          p_insert_rows: Json
          p_update_rows: Json
        }
        Returns: undefined
      }
      apply_supplier_master_import: {
        Args: {
          p_file_size: number
          p_import_id: string
          p_insert_rows: Json
          p_inserted_count: number
          p_original_filename: string
          p_rejected_count: number
          p_row_count: number
          p_storage_path: string
          p_unchanged_count: number
          p_update_rows: Json
          p_updated_count: number
          p_uploaded_by: string
        }
        Returns: undefined
      }
      approve_medical_license: {
        Args: {
          p_approval_id: string
          p_confirmed_end_date: string
          p_confirmed_start_date: string
        }
        Returns: undefined
      }
      can_manage_employee: { Args: { p_employee_id: string }; Returns: boolean }
      classify_overtime_type_id: {
        Args: { p_work_date: string }
        Returns: string
      }
      cleanup_demo_data: {
        Args: never
        Returns: {
          rows_deleted: number
          table_name: string
        }[]
      }
      current_user_role: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
      }
      is_admin_rrhh: { Args: never; Returns: boolean }
      is_corporate_user: { Args: never; Returns: boolean }
      is_medical_license_approver: { Args: never; Returns: boolean }
      is_privileged_admin: { Args: never; Returns: boolean }
      is_super_admin: { Args: never; Returns: boolean }
      is_supervisor_installation: { Args: never; Returns: boolean }
      is_supervisor_production: { Args: never; Returns: boolean }
      max_approvable_overtime_minutes: {
        Args: {
          p_employee_group_code: string
          p_overtime_type_id: string
          p_work_date: string
        }
        Returns: number
      }
      production_two_hour_proposal_minutes: {
        Args: { p_candidate_minutes: number }
        Returns: number
      }
      production_two_hour_requires_manual_review: {
        Args: { p_candidate_minutes: number }
        Returns: boolean
      }
      reclaim_stale_workera_sync_runs: {
        Args: { p_stale_after_seconds?: number }
        Returns: number
      }
      recompute_employee_daily_bonus: {
        Args: { p_employee_id: string; p_work_date: string }
        Returns: undefined
      }
      reject_medical_license: {
        Args: { p_approval_id: string; p_reason: string }
        Returns: undefined
      }
    }
    Enums: {
      app_role:
        | "ADMIN_RRHH"
        | "SUPERVISOR_PRODUCTION"
        | "SUPERVISOR_INSTALLATION"
        | "SUPER_ADMIN"
      daily_review_status:
        | "IMPORTED"
        | "PENDING_REVIEW"
        | "REVIEWED"
        | "NEEDS_REVIEW"
        | "SYNC_CONFLICT"
        | "CORRECTED_AFTER_REVIEW"
        | "READY_FOR_WEEKLY_CLOSE"
      medical_license_approval_status:
        | "PENDING_RRHH_APPROVAL"
        | "APPROVED"
        | "REJECTED"
      missing_punch_status:
        | "PENDING_CONTACT"
        | "CONTACTED"
        | "RESOLVED"
        | "UNRESOLVED"
      missing_punch_type:
        | "MISSING_CLOCK_IN"
        | "MISSING_CLOCK_OUT"
        | "MISSING_BOTH"
      overtime_decision_status:
        | "FULLY_APPROVED"
        | "PARTIALLY_APPROVED"
        | "REJECTED"
      reporting_period_status:
        | "OPEN"
        | "IN_REVIEW"
        | "READY_TO_CLOSE"
        | "CLOSED"
        | "REOPENED"
      supplier_master_import_status:
        | "VALIDATING"
        | "READY"
        | "IMPORTING"
        | "ACTIVE"
        | "REPLACED"
        | "FAILED"
      sync_run_status: "RUNNING" | "SUCCEEDED" | "FAILED" | "PARTIAL"
      weekly_review_status: "OPEN" | "READY_TO_CLOSE" | "CLOSED" | "REOPENED"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_role: [
        "ADMIN_RRHH",
        "SUPERVISOR_PRODUCTION",
        "SUPERVISOR_INSTALLATION",
        "SUPER_ADMIN",
      ],
      daily_review_status: [
        "IMPORTED",
        "PENDING_REVIEW",
        "REVIEWED",
        "NEEDS_REVIEW",
        "SYNC_CONFLICT",
        "CORRECTED_AFTER_REVIEW",
        "READY_FOR_WEEKLY_CLOSE",
      ],
      medical_license_approval_status: [
        "PENDING_RRHH_APPROVAL",
        "APPROVED",
        "REJECTED",
      ],
      missing_punch_status: [
        "PENDING_CONTACT",
        "CONTACTED",
        "RESOLVED",
        "UNRESOLVED",
      ],
      missing_punch_type: [
        "MISSING_CLOCK_IN",
        "MISSING_CLOCK_OUT",
        "MISSING_BOTH",
      ],
      overtime_decision_status: [
        "FULLY_APPROVED",
        "PARTIALLY_APPROVED",
        "REJECTED",
      ],
      reporting_period_status: [
        "OPEN",
        "IN_REVIEW",
        "READY_TO_CLOSE",
        "CLOSED",
        "REOPENED",
      ],
      supplier_master_import_status: [
        "VALIDATING",
        "READY",
        "IMPORTING",
        "ACTIVE",
        "REPLACED",
        "FAILED",
      ],
      sync_run_status: ["RUNNING", "SUCCEEDED", "FAILED", "PARTIAL"],
      weekly_review_status: ["OPEN", "READY_TO_CLOSE", "CLOSED", "REOPENED"],
    },
  },
} as const

